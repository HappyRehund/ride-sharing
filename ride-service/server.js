// ride-sharing/ride-service/server.js
const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const amqp = require("amqplib");
const { Pool } = require("pg");
const { v4: uuidv4 } = require("uuid");

const app = express();
const PORT = process.env.PORT || 3001;
const AUTH_SERVICE_URL =
  process.env.AUTH_SERVICE_URL || "http://auth-service:3000";

// PostgreSQL Connection Pool
const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: parseInt(process.env.DB_PORT || "5432", 10),
});

let server;
let amqpConnection;

pool.on("connect", () =>
  console.log("Ride-service connected to PostgreSQL database!")
);
pool.on("error", (err) => console.error("Ride-service DB Pool Error:", err));

app.use(bodyParser.json());

const authMiddleware = async (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) {
    return res.status(401).send({ message: "Unauthorized: No token provided" });
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
      return res.status(401).send({ message: "Invalid or expired token" });
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
      "Auth service error in ride-service:",
      error.response ? error.response.data : error.message
    );
    res
      .status(500)
      .json({ message: "Authentication service error or unavailable" });
  }
};

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

      // Tambahkan event listeners
      amqpConnection.on("error", (err) => {
        console.error("Ride-service RabbitMQ connection error:", err.message);
      });

      amqpConnection.on("close", () => {
        console.warn("Ride-service RabbitMQ connection closed.");
      });

      console.log("Ride-service connected to RabbitMQ");
      channel = newChannel;
      return true;
    } catch (error) {
      console.error(
        `Ride-service RabbitMQ connection attempt ${6 - retries}/5 failed:`,
        error
      );
      retries--;
      if (retries === 0) throw error;
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
};

app.post("/request-ride", authMiddleware, async (req, res) => {
  const { pickup, destination } = req.body;
  // req.user comes from authMiddleware: { id, username, role }
  const { id: riderUserId, username: riderUsername, role } = req.user;

  if (role !== "rider") {
    return res
      .status(403)
      .send({ message: "Only riders can send ride requests" });
  }
  if (!pickup || !destination) {
    return res
      .status(400)
      .send({ message: "Pickup and destination are required" });
  }

  const rideId = uuidv4();
  const requestedAt = new Date();

  try {
    const result = await pool.query(
      `INSERT INTO rides (id, rider_user_id, rider_username, pickup_location_text, destination_location_text, status, requested_at)
             VALUES ($1, $2, $3, $4, $5, 'pending', $6) RETURNING *`,
      [rideId, riderUserId, riderUsername, pickup, destination, requestedAt]
    );
    const newRide = result.rows[0];

    if (channel) {
      const rideEventPayload = {
        // Construct payload for RabbitMQ
        id: newRide.id,
        userId: newRide.rider_user_id, // For consistency with driver-service handler
        username: newRide.rider_username,
        pickup: newRide.pickup_location_text,
        destination: newRide.destination_location_text,
        status: newRide.status,
        createdAt: newRide.requested_at.toISOString(), // Send ISO string
      };
      channel.publish(
        "ride_events",
        "ride.requested",
        Buffer.from(JSON.stringify(rideEventPayload))
      );
      console.log(`Published ride request: ${newRide.id}`);
    }
    res
      .status(201)
      .send({ message: "Ride request sent successfully", ride: newRide });
  } catch (dbError) {
    console.error("Error requesting ride:", dbError);
    res.status(500).send({ message: "Error processing ride request" });
  }
});

app.get("/rides", authMiddleware, async (req, res) => {
  const { id: userId, role } = req.user;
  try {
    let query;
    let queryParams = [userId];
    if (role === "rider") {
      query =
        "SELECT * FROM rides WHERE rider_user_id = $1 ORDER BY requested_at DESC";
    } else if (role === "driver") {
      // Drivers might see rides assigned to them or potentially all 'pending' ones if you don't use driver-service's available rides endpoint for that
      query =
        "SELECT * FROM rides WHERE driver_id = $1 OR (status = 'pending' AND driver_id IS NULL) ORDER BY requested_at DESC";
    } else {
      // Admin or other roles might see all rides
      query = "SELECT * FROM rides ORDER BY requested_at DESC";
      queryParams = [];
    }
    if (!query) {
      return res.status(403).json({
        message: "User role not permitted to view rides in this manner.",
      });
    }

    const result = await pool.query(query, queryParams);
    res.json({ rides: result.rows });
  } catch (dbError) {
    console.error("Error fetching rides:", dbError);
    res.status(500).json({ message: "Error fetching rides" });
  }
});

app.get("/ride/:id", authMiddleware, async (req, res) => {
  const { id: rideId } = req.params;
  // Optionally, add authorization: check if req.user.id (rider or driver) is associated with this ride
  try {
    const result = await pool.query("SELECT * FROM rides WHERE id = $1", [
      rideId,
    ]);
    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Ride not found" });
    }
    // Add authorization check here if needed based on req.user and result.rows[0]
    res.json({ ride: result.rows[0] });
  } catch (dbError) {
    console.error(`Error fetching ride ${rideId}:`, dbError);
    res.status(500).json({ message: "Error fetching ride details" });
  }
});

// Internal endpoint for driver-service to update ride status
app.post("/internal/update-ride", async (req, res) => {
  const { rideId, driverId, driverUsername, status } = req.body;

  // Basic validation
  if (!rideId || !status) {
    return res
      .status(400)
      .json({ message: "Ride ID and status are required." });
  }
  if (status === "accepted" && (!driverId || !driverUsername)) {
    return res.status(400).json({
      message: "Driver ID and username are required for accepted status.",
    });
  }

  try {
    let updateQuery;
    let queryParams;
    const now = new Date();

    if (status === "accepted") {
      updateQuery = `UPDATE rides SET driver_id = $1, driver_username = $2, status = $3, accepted_at = $4, updated_at = $4
                           WHERE id = $5 AND status = 'pending' RETURNING *`;
      queryParams = [driverId, driverUsername, status, now, rideId];
    } else if (status === "completed") {
      updateQuery = `UPDATE rides SET status = $1, completed_at = $2, updated_at = $2
                           WHERE id = $3 AND driver_id = $4 AND status = 'accepted' RETURNING *`; // Or 'ongoing' if you have that status
      queryParams = [status, now, rideId, driverId];
    } else if (status === "ongoing") {
      // Example for another status
      updateQuery = `UPDATE rides SET status = $1, started_at = $2, updated_at = $2
                           WHERE id = $3 AND driver_id = $4 AND status = 'accepted' RETURNING *`;
      queryParams = [status, now, rideId, driverId];
    }
    // Add more statuses like 'cancelled' as needed
    else {
      return res
        .status(400)
        .json({ message: "Invalid ride status for update." });
    }

    const result = await pool.query(updateQuery, queryParams);

    if (result.rows.length === 0) {
      return res.status(404).json({
        message: `Ride not found, not in a state to be '${status}', or driver mismatch.`,
      });
    }
    const updatedRide = result.rows[0];

    if (channel) {
      channel.publish(
        "ride_events",
        `ride.${status}`, // e.g., ride.accepted, ride.completed
        Buffer.from(JSON.stringify(updatedRide))
      );
      console.log(
        `Published ride update from internal: ${updatedRide.id} -> ${status}`
      );
    }
    res.json({ message: "Ride updated successfully", ride: updatedRide });
  } catch (dbError) {
    console.error(`Error updating ride ${rideId} to ${status}:`, dbError);
    res.status(500).json({ message: "Error updating ride" });
  }
});

// Start server
const startServer = async () => {
  try {
    await pool.query("SELECT NOW()");
    console.log("Ride-service database connection successful.");

    await rabbitMqConnect();
    console.log("Ride-service RabbitMQ connection successful.");

    server = app.listen(PORT, () => {
      console.log(`Ride service listening on port ${PORT}`);
    });
  } catch (err) {
    console.error("Ride-service failed to start:", err);
    process.exit(1);
  }
};

const gracefulShutdown = async (signal) => {
  console.log(`\n${signal} received. Shutting down Ride service gracefully...`);

  if (server) {
    server.close(async () => {
      console.log("Ride service HTTP server closed.");

      if (channel) {
        try {
          await channel.close();
          console.log("Ride service RabbitMQ channel closed.");
        } catch (err) {
          console.error(
            "Ride service Error closing RabbitMQ channel:",
            err.message
          );
        }
      }

      if (amqpConnection) {
        try {
          await amqpConnection.close();
          console.log("Ride service RabbitMQ connection closed.");
        } catch (err) {
          console.error(
            "Ride service Error closing RabbitMQ connection:",
            err.message
          );
        }
      }

      if (pool) {
        try {
          await pool.end();
          console.log("Ride service PostgreSQL pool closed.");
        } catch (err) {
          console.error(
            "Ride service Error closing PostgreSQL pool:",
            err.message
          );
        }
      }

      console.log("Ride service shutdown complete.");
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

// Tambahkan signal handlers
process.on("SIGINT", gracefulShutdown);
process.on("SIGTERM", gracefulShutdown);

startServer();
