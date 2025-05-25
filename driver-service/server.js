// ride-sharing/driver-service/server.js
const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const amqp = require("amqplib");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3002;
const AUTH_SERVICE_URL =
  process.env.AUTH_SERVICE_URL || "http://auth-service:3000";
const RIDE_SERVICE_URL =
  process.env.RIDE_SERVICE_URL || "http://ride-service:3001";

let amqpConnection;
let server;

// PostgreSQL Connection Pool
const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: parseInt(process.env.DB_PORT || "5432", 10),
});

pool.on("connect", () =>
  console.log("Driver-service connected to PostgreSQL database!")
);
pool.on("error", (err) => console.error("Driver-service DB Pool Error:", err));

// Middleware
app.use(bodyParser.json());

// Auth middleware
const authMiddleware = async (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) {
    return res.status(401).json({ message: "Authentication required" });
  }
  try {
    const response = await axios.post(
      `${AUTH_SERVICE_URL}/verify-token`,
      {},
      {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 5000,
      }
    );
    if (!response.data.valid) {
      return res.status(401).json({ message: "Invalid or expired token" });
    }
    req.user = response.data.user; // user contains { id, username, role }
    next();
  } catch (error) {
    if (error.code === "ECONNABORTED") {
      console.error("Auth service request timed out:", error.message);
      return res
        .status(504)
        .json({ message: "Authentication service timed out" }); // Gateway Timeout
    }
    console.error(
      "Auth service error:",
      error.response ? error.response.data : error.message
    );
    res
      .status(500)
      .json({ message: "Authentication service unavailable or error" });
  }
};

// RabbitMQ connection
let channel;
const rabbitMqConnect = async () => {
  let retries = 5;
  while (retries > 0) {
    try {
      amqpConnection = await amqp.connect(
        `amqp://${process.env.RABBITMQ_HOST || "localhost"}`
      );
      const newChannel = await amqpConnection.createChannel();
      await newChannel.assertExchange("ride_events", "topic", {
        durable: false,
      });
      await newChannel.assertExchange("user_events", "topic", {
        durable: false,
      });
      await newChannel.assertExchange("driver_ride_actions", "topic", { durable: false });
      const q = await newChannel.assertQueue("driver_service_queue", {
        exclusive: false,
      });
      await newChannel.bindQueue(q.queue, "ride_events", "ride.requested");
      await newChannel.bindQueue(q.queue, "user_events", "user.role.updated");

      newChannel.consume(q.queue, async (msg) => {
        if (!msg) return;
        try {
          const content = JSON.parse(msg.content.toString());
          if (msg.fields.routingKey === "ride.requested") {
            await handleRideRequest(content);
          } else if (msg.fields.routingKey === "user.role.updated") {
            await handleUserRoleUpdate(content);
          }
          newChannel.ack(msg);
        } catch (err) {
          console.error("Error processing message:", err);
          newChannel.nack(msg, false, false);
        }
      });

      amqpConnection.on("error", (err) => {
        console.error("Driver-service RabbitMQ connection error:", err.message);
      });

      amqpConnection.on("close", () => {
        console.warn("Driver-service RabbitMQ connection closed.");
      });

      channel = newChannel;
      return true;
    } catch (error) {
      console.error(
        `Driver-service RabbitMQ connection attempt ${6 - retries}/5 failed:`,
        error
      );
      retries--;
      if (retries === 0) throw error;
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
};

// Message handlers
const handleRideRequest = async (ride) => {
  console.log(`New ride request received by driver-service: ${ride.id}`);
  try {
    // Store in local pending_rides table
    await pool.query(
      `INSERT INTO pending_rides (ride_id, rider_id, rider_username, pickup_location, destination_location, status, requested_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (ride_id) DO NOTHING`,
      [
        ride.id,
        ride.userId,
        ride.username,
        ride.pickup,
        ride.destination,
        "pending",
        ride.createdAt,
      ]
    );
    console.log(`Ride ${ride.id} stored as pending for drivers.`);
  } catch (dbError) {
    console.error(`Error storing pending ride ${ride.id}:`, dbError);
  }
};

const handleUserRoleUpdate = async (user) => {
  // user should be { id, username, role }
  if (user.role === "driver") {
    try {
      await pool.query(
        `INSERT INTO drivers (user_id, username, is_available)
                 VALUES ($1, $2, TRUE)
                 ON CONFLICT (user_id) DO UPDATE SET username = $2`, // Can update other fields if needed
        [user.id, user.username] // Ensure your auth-service sends user.id
      );
      console.log(
        `Driver registered/updated in DB: ${user.username} (ID: ${user.id})`
      );
    } catch (dbError) {
      console.error(
        `Error registering/updating driver ${user.username}:`,
        dbError
      );
    }
  }
  // You might want to handle if a user is no longer a driver (e.g., mark as unavailable or remove)
};

// Routes
app.get("/available-rides", authMiddleware, async (req, res) => {
  const { role } = req.user;
  if (role !== "driver") {
    return res
      .status(403)
      .json({ message: "Only drivers can view available rides" });
  }
  try {
    const result = await pool.query(
      "SELECT * FROM pending_rides WHERE status = 'pending' ORDER BY requested_at ASC"
    );
    res.json({ rides: result.rows });
  } catch (dbError) {
    console.error("Error fetching available rides:", dbError);
    res.status(500).json({ message: "Error fetching available rides" });
  }
});

app.post("/accept-ride/:rideId", authMiddleware, async (req, res) => {
  const { id: driverId, username: driverUsername, role } = req.user;
  const { rideId } = req.params;

  if (role !== "driver") {
    return res.status(403).json({ message: "Only drivers can accept rides" });
  }

  const client = await pool.connect(); // For transaction
  try {
    await client.query("BEGIN");

    const driverResult = await client.query(
      "SELECT * FROM drivers WHERE user_id = $1 FOR UPDATE",
      [driverId]
    );
    const driver = driverResult.rows[0];

    if (!driver) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Driver profile not found." });
    }
    if (!driver.is_available || driver.current_ride_id) {
      await client.query("ROLLBACK");
      return res
        .status(400)
        .json({
          message: "You are not available or already have an active ride",
        });
    }

    const rideResult = await client.query(
      "SELECT * FROM pending_rides WHERE ride_id = $1 AND status = $2 FOR UPDATE",
      [rideId, "pending"]
    );
    const ride = rideResult.rows[0];

    if (!ride) {
      await client.query("ROLLBACK");
      return res
        .status(404)
        .json({ message: "Ride not found, already accepted, or not pending" });
    }

    // Update ride status in ride-service (Now we don't need it because we handle it using rabbitMQ)
    // await axios.post(`${RIDE_SERVICE_URL}/internal/update-ride`, {
    //   rideId,
    //   driverId,
    //   driverUsername,
    //   status: "accepted",
    // });

    // Update driver status locally
    await client.query(
      "UPDATE drivers SET is_available = FALSE, current_ride_id = $1 WHERE user_id = $2",
      [rideId, driverId]
    );

    // Remove from local pending_rides or mark as accepted
    await client.query("DELETE FROM pending_rides WHERE ride_id = $1", [
      rideId,
    ]);
    // Or: await client.query("UPDATE pending_rides SET status = 'accepted' WHERE ride_id = $1", [rideId]);

    await client.query("COMMIT");

    if (channel) {
      const eventPayload = {
        rideId,
        driverId,
        driverUsername,
        status: "accepted", // Status baru yang diinginkan
        timestamp: new Date().toISOString(),
      };
      channel.publish(
        "driver_ride_actions",      // Exchange baru
        "ride.action.accepted",     // Routing key baru
        Buffer.from(JSON.stringify(eventPayload))
      );
      console.log(`[Driver Service] Published ride.action.accepted event for ride ${rideId}`);
    }

    res.json({ message: "Ride accepted processed, status update will be eventual", rideId });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(
      "Error accepting ride:",
      error.response ? error.response.data : error.message
    );
    res
      .status(500)
      .json({
        message:
          "Failed to accept ride. Internal error or ride service communication issue.",
      });
  } finally {
    client.release();
  }
});

app.post("/complete-ride/:rideId", authMiddleware, async (req, res) => {
  const { id: driverId, username: driverUsername, role } = req.user;
  const { rideId } = req.params;

  if (role !== "driver") {
    return res.status(403).json({ message: "Only drivers can complete rides" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const driverResult = await client.query(
      "SELECT * FROM drivers WHERE user_id = $1 FOR UPDATE",
      [driverId]
    );
    const driver = driverResult.rows[0];

    if (!driver || driver.current_ride_id !== rideId) {
      await client.query("ROLLBACK");
      return res
        .status(403)
        .json({
          message: "You are not assigned to this ride or driver not found",
        });
    }

    // Update ride status in ride-service (Now we don't need it because we handle it using rabbitMQ)
    // await axios.post(`${RIDE_SERVICE_URL}/internal/update-ride`, {
    //   rideId,
    //   driverId,
    //   driverUsername, // Send username from auth token, or fetch from driver profile
    //   status: "completed",
    // });

    // Update driver status locally
    await client.query(
      "UPDATE drivers SET is_available = TRUE, current_ride_id = NULL WHERE user_id = $1",
      [driverId]
    );

    await client.query("COMMIT");

    if (channel) {
      const eventPayload = {
        rideId,
        driverId,
        driverUsername: driver.username, // Ambil dari data driver di DB jika perlu
        status: "completed", // Status baru yang diinginkan
        timestamp: new Date().toISOString(),
      };
      channel.publish(
        "driver_ride_actions",      // Exchange baru
        "ride.action.completed",    // Routing key baru
        Buffer.from(JSON.stringify(eventPayload))
      );
      console.log(`[Driver Service] Published ride.action.completed event for ride ${rideId}`);
    }

    res.json({ message: "Ride completed successfully", rideId });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(
      "Error completing ride:",
      error.response ? error.response.data : error.message
    );
    res
      .status(500)
      .json({
        message:
          "Failed to complete ride. Internal error or ride service communication issue.",
      });
  } finally {
    client.release();
  }
});

app.get("/driver-status", authMiddleware, async (req, res) => {
  const { id: driverId, role } = req.user;
  if (role !== "driver") {
    return res
      .status(403)
      .json({ message: "Only drivers can check driver status" });
  }
  try {
    const result = await pool.query(
      "SELECT user_id as id, username, is_available, current_ride_id, vehicle_details FROM drivers WHERE user_id = $1",
      [driverId]
    );
    if (result.rows.length === 0) {
      // If driver entry doesn't exist yet (e.g., new driver who hasn't been processed by role update yet)
      return res.json({
        driver: {
          id: driverId,
          username: req.user.username,
          is_available: true,
          current_ride_id: null,
          vehicle_details: null,
        },
      });
    }
    res.json({ driver: result.rows[0] });
  } catch (dbError) {
    console.error("Error fetching driver status:", dbError);
    res.status(500).json({ message: "Error fetching driver status" });
  }
});

// Start server
const startServer = async () => {
  try {
    await pool.query("SELECT NOW()");
    console.log("Driver-service database connection successful.");

    await rabbitMqConnect();
    console.log("Driver-service RabbitMQ connection successful.");

    server = app.listen(PORT, () => {
      console.log(`Driver service running on port ${PORT}`);
    });
  } catch (err) {
    console.error("Driver-service failed to start:", err);
    process.exit(1);
  }
};

const gracefulShutdown = async (signal) => {
  console.log(
    `\n${signal} received. Shutting down Driver service gracefully...`
  );

  if (server) {
    server.close(async () => {
      console.log("Driver service HTTP server closed.");

      if (channel) {
        try {
          await channel.close();
          console.log("Driver service RabbitMQ channel closed.");
        } catch (err) {
          console.error(
            "Driver service Error closing RabbitMQ channel:",
            err.message
          );
        }
      }

      if (amqpConnection) {
        try {
          await amqpConnection.close();
          console.log("Driver service RabbitMQ connection closed.");
        } catch (err) {
          console.error(
            "Driver service Error closing RabbitMQ connection:",
            err.message
          );
        }
      }

      if (pool) {
        try {
          await pool.end();
          console.log("Driver service PostgreSQL pool closed.");
        } catch (err) {
          console.error(
            "Driver service Error closing PostgreSQL pool:",
            err.message
          );
        }
      }

      console.log("Driver service shutdown complete.");
      process.exit(0);
    });
  } else {
    if (amqpConnection)
      await amqpConnection.close().catch((e) => console.error(e.message));
    if (pool) await pool.end().catch((e) => console.error(e.message));
    process.exit(0);
  }

  setTimeout(() => {
    console.error("Graceful shutdown timed out. Forcing exit.");
    process.exit(1);
  }, 10000);
};

process.on("SIGINT", gracefulShutdown);
process.on("SIGTERM", gracefulShutdown);

startServer();
