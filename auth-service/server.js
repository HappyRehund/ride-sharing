// ride-sharing/auth-service/server.js
const bodyParser = require("body-parser");
const express = require("express");
const amqp = require("amqplib");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg"); // Import pg
const { v4: uuidv4 } = require("uuid");

let amqpConnection;
let server;

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "supanigga"; // Use environment variable
const app = express();

// PostgreSQL Connection Pool
const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: parseInt(process.env.DB_PORT || "5432", 10),
  max: 20, // Max number of clients in the pool
  idleTimeoutMillis: 30000, // How long a client is allowed to remain idle before being closed
  connectionTimeoutMillis: 5000, // How long to wait for a connection from the pool
});

pool.on("connect", () => {
  console.log("Connected to PostgreSQL database!");
});

pool.on("error", (err) => {
  console.error("Unexpected error on idle client", err);
  process.exit(-1); // Exit if the pool encounters a critical error
});

// Test DB connection on startup
const testDbConnection = async () => {
  let retries = 5;
  while (retries > 0) {
    try {
      await pool.query("SELECT NOW()");
      console.log("Auth-service database connection successful.");
      return true;
    } catch (err) {
      console.error(
        `Database connection attempt ${6 - retries}/5 failed:`,
        err.stack
      );
      retries--;
      if (retries === 0) throw err;
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
};

app.use(bodyParser.json());

let channel;
const rabbitMqConnect = async () => {
  let retries = 5;
  while (retries > 0) {
    try {
      amqpConnection = await amqp.connect(
        `amqp://${process.env.RABBITMQ_HOST || "localhost"}`
      );
      const newChannel = await amqpConnection.createChannel();
      await newChannel.assertExchange("user_events", "topic", {
        durable: false,
      });
      console.log("Auth-service connected to RabbitMQ");

      amqpConnection.on("error", (err) => {
        console.error("Auth-service RabbitMQ connection error:", err.message);
      });

      amqpConnection.on("close", () => {
        console.warn("Auth-service RabbitMQ connection closed.");
      });

      channel = newChannel;
      return true;
    } catch (error) {
      console.error(
        `Auth-service RabbitMQ connection attempt ${6 - retries}/5 failed:`,
        error
      );
      retries--;
      if (retries === 0) throw error;
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
};

app.post("/register", async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res
      .status(400)
      .send({ message: "Username and password are required" });
  }

  try {
    // Check if user already exists
    const existingUser = await pool.query(
      "SELECT * FROM users WHERE username = $1",
      [username]
    );
    if (existingUser.rows.length > 0) {
      return res.status(400).send({ message: "Username already exists" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const userId = uuidv4();

    const newUser = await pool.query(
      "INSERT INTO users (id, username, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id, username, role",
      [userId, username, hashedPassword, null]
    );

    res.status(201).json({
      message: "User registered successfully",
      user: newUser.rows[0],
    });
  } catch (error) {
    console.error("Registration error:", error);
    res
      .status(500)
      .send({ message: "Internal server error during registration" });
  }
});

app.post("/login", async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res
      .status(400)
      .send({ message: "Username and password are required" });
  }

  try {
    const result = await pool.query("SELECT * FROM users WHERE username = $1", [
      username,
    ]);
    const user = result.rows[0];

    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).send({ message: "Invalid credentials" });
    }

    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role },
      JWT_SECRET,
      { expiresIn: "1h" }
    );

    res.status(200).json({
      message: "Login successful",
      token,
      username: user.username,
      role: user.role,
    });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).send({ message: "Internal server error during login" });
  }
});

app.post("/set-role", async (req, res) => {
  const { username, role } = req.body;
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return res.status(401).send({ message: "Unauthorized: No token provided" });
  }
  const token = authHeader.split(" ")[1];
  if (!token) {
    return res
      .status(401)
      .send({ message: "Unauthorized: Token format invalid" });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);

    if (decoded.username !== username) {
      // Allow admin to change roles in future? For now, only self-change.
      return res
        .status(403)
        .send({ message: "Forbidden: You can only change your own role" });
    }

    if (!["rider", "driver"].includes(role)) {
      return res
        .status(400)
        .send({ message: 'Invalid role. Must be "rider" or "driver"' });
    }

    const updateResult = await pool.query(
      "UPDATE users SET role = $1 WHERE username = $2 RETURNING id, username, role",
      [role, username]
    );

    if (updateResult.rows.length === 0) {
      return res.status(404).send({ message: "User not found" });
    }

    const updatedUser = updateResult.rows[0];

    const newToken = jwt.sign(
      {
        id: updatedUser.id,
        username: updatedUser.username,
        role: updatedUser.role,
      },
      JWT_SECRET,
      { expiresIn: "1h" }
    );

    if (channel) {
      channel.publish(
        "user_events",
        "user.role.updated",
        Buffer.from(
          JSON.stringify({
            id: updatedUser.id,
            username: updatedUser.username,
            role: updatedUser.role,
          })
        )
      );
    }

    res.json({
      message: "Role updated successfully",
      token: newToken,
      user: {
        id: updatedUser.id,
        username: updatedUser.username,
        role: updatedUser.role,
      },
    });
  } catch (error) {
    if (
      error.name === "JsonWebTokenError" ||
      error.name === "TokenExpiredError"
    ) {
      return res.status(401).send({ message: "Invalid or expired token" });
    }
    console.error("Set role error:", error);
    res
      .status(500)
      .send({ message: "Internal server error while setting role" });
  }
});

app.post("/verify-token", (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res
      .status(401)
      .send({ valid: false, message: "Unauthorized: No token provided" });
  }
  const token = authHeader.split(" ")[1];
  if (!token) {
    return res
      .status(401)
      .send({ valid: false, message: "Unauthorized: Token format invalid" });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    // Optionally, you could query the DB here to ensure the user still exists and is active
    res.json({
      valid: true,
      user: decoded,
    });
  } catch (error) {
    res.status(401).json({
      // Send 401 for invalid/expired token
      valid: false,
      message: error.message || "Invalid or expired token",
    });
  }
});

const startServer = async () => {
  try {
    await testDbConnection();
    await rabbitMqConnect();

    server = app.listen(PORT, () => {
      console.log(`Auth service listening on port ${PORT}`);
    });
  } catch (err) {
    console.error("Auth-service failed to start:", err);
    process.exit(1);
  }
};

const gracefulShutdown = async (signal) => {
  console.log(`\n${signal} received. Shutting down Auth service gracefully...`);

  if (server) {
    server.close(async () => {
      console.log("Auth service HTTP server closed.");

      if (channel) {
        try {
          await channel.close();
          console.log("Auth service RabbitMQ channel closed.");
        } catch (err) {
          console.error(
            "Auth service Error closing RabbitMQ channel:",
            err.message
          );
        }
      }

      if (amqpConnection) {
        try {
          await amqpConnection.close();
          console.log("Auth service RabbitMQ connection closed.");
        } catch (err) {
          console.error(
            "Auth service Error closing RabbitMQ connection:",
            err.message
          );
        }
      }

      if (pool) {
        try {
          await pool.end();
          console.log("Auth service PostgreSQL pool closed.");
        } catch (err) {
          console.error(
            "Auth service Error closing PostgreSQL pool:",
            err.message
          );
        }
      }

      console.log("Auth service shutdown complete.");
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

// Tambahkan signal handlers:
process.on("SIGINT", gracefulShutdown);
process.on("SIGTERM", gracefulShutdown);

startServer();
