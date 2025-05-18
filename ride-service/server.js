//ride-sharing/ride-service/server.js
const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const amqp = require("amqplib");

const app = express();
const PORT = 3001;

//in memory soal e lagi nyoba beneran connect ga RabbitMQ
const rides = {};

app.use(bodyParser.json());

const authMiddleware = async (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];

  if (!token) {
    return res.status(401).send({ message: "Unauthorized" });
  }

  try {
    const response = await axios.post(
      "http://auth-service:3000/verify-token",
      {},
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }
    );

    if (!response.data.valid) {
      return res.status(401).send({ message: "Invalid or expired token" });
    }

    req.user = response.data.user;
    next();
  } catch (error) {
    console.error("Auth service error:", error);
    res.status(500).json({
      message: "Something happened in Auth service",
    });
  }
};
let channel;
const rabbitMqConnect = async () => {
  try {
    const connection = await amqp.connect(
      `amqp://${process.env.RABBITMQ_HOST || "localhost"}`
    );

    channel = await connection.createChannel();

    await channel.assertExchange("ride_events", "topic", { durable: false });

    console.log("Connected to RabbitMQ");
  } catch (error) {
    console.error("RabbitMQ connecion error:", error);
    setTimeout(rabbitMqConnect, 5000);
  }
};

app.post("/request-ride", authMiddleware, (req, res) => {
  // destructure pickup and destination
  const { pickup, destination } = req.body;
  const { userId, username, role } = req.user; //dapet dr middleware (token)
  //destructure userId, username, role

  //role check - only riders can request rides
  if (role !== "rider") {
    return res
      .status(401)
      .send({ message: "Only riders can send ride requests" });
  }

  //check if there's pickup and destination
  if (!pickup || !destination) {
    return res
      .status(400)
      .send({ message: "Pickup and destination are required" });
  }
  // create ride id
  const rideId = Date.now().toString();
  // buat ride var dengan informasi yang akan disimpan ke db
  const ride = {
    id: rideId,
    userId,
    username,
    pickup,
    destination,
    status: "pending",
    createdAt: new Date().toISOString(),
    driverId: null,
    driverUsername: null,
  };

  rides[rideId] = ride;

  if (channel) {
    channel.publish(
      "ride_events",
      "ride.requested",
      Buffer.from(JSON.stringify(ride))
    );
    console.log(`Published ride request: ${rideId}`);
  }

  res.status(201).send({ message: "Ride request sent successfully", ride });
});

app.get("/rides", authMiddleware, (req, res) => {
  //dapetin userId sm role dari middleware (token dr auth service)

  const { id: userId, role } = req.user;

  // object rides diambil dr global scope trus diubah jadi array
  //filter untuk role rider or role driver
  const userRides = Object.values(rides).filter((ride) => {
    if (role === "rider") {
      return ride.userId === userId;
    } else if (role === "driver") {
      return ride.driverId === userId || ride.status === "pending";
    }
    return false;
  });

  res.json({ rides: userRides });
  //return res json
});

app.get("/ride/:id", authMiddleware, (req, res) => {
  const { id } = req.params;
  const ride = rides[id];

  if (!ride) {
    return res.status(404).json({ message: "Ride not found" });
  }

  res.json({ ride });
});

app.post("/internal/update-ride", async (req, res) => {
  const { rideId, driverId, driverUsername, status } = req.body;

  if (!rides[rideId]) {
    return res.status(404).json({ message: "Ride not found" });
  }

  rides[rideId] = {
    ...rides[rideId],
    status,
    driverId,
    driverUsername,
    updatedAt: new Date().toISOString(),
  };

  if (channel) {
    channel.publish(
      "ride_events",
      `ride.${status}`,
      Buffer.from(JSON.stringify(rides[rideId]))
    );
    console.log(`Published ride update: ${rideId} -> ${status}`);
  }

  res.json({
    message: "Ride updated successfully",
    ride: rides[rideId],
  });
});

app.listen(PORT, async () => {
  console.log(`Ride service listening on port ${PORT}`);
  await rabbitMqConnect();
});
