const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const amqp = require('amqplib');

const app = express();
const PORT = 3002;

// In-memory driver storage (use a real DB in production)
const drivers = {};
const pendingRides = {};

// Middleware
app.use(bodyParser.json());

// Auth middleware
const authMiddleware = async (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ message: 'Authentication required' });
  }
  
  try {
    // Verify token with auth service
    const response = await axios.post('http://auth-service:3000/verify-token', {}, {
      headers: { Authorization: `Bearer ${token}` }
    });
    
    if (!response.data.valid) {
      return res.status(401).json({ message: 'Invalid or expired token' });
    }
    
    req.user = response.data.user;
    next();
  } catch (error) {
    console.error('Auth service error:', error.message);
    res.status(500).json({ message: 'Authentication service unavailable' });
  }
};

// RabbitMQ connection
let channel;
const rabbitMqConnect = async () => {
  try {
    const connection = await amqp.connect(`amqp://${process.env.RABBITMQ_HOST || 'localhost'}`);
    channel = await connection.createChannel();
    
    // Define exchanges and queues
    await channel.assertExchange('ride_events', 'topic', { durable: false });
    await channel.assertExchange('user_events', 'topic', { durable: false });
    
    const q = await channel.assertQueue('driver_service_queue', { exclusive: false });
    
    // Bind queue to exchanges with specific routing keys
    await channel.bindQueue(q.queue, 'ride_events', 'ride.requested');
    await channel.bindQueue(q.queue, 'user_events', 'user.role_updated');
    
    // Consume messages
    channel.consume(q.queue, msg => {
      if (msg.fields.routingKey === 'ride.requested') {
        handleRideRequest(JSON.parse(msg.content.toString()));
      } else if (msg.fields.routingKey === 'user.role_updated') {
        handleUserRoleUpdate(JSON.parse(msg.content.toString()));
      }
      
      channel.ack(msg);
    });
    
    console.log('Connected to RabbitMQ');
  } catch (error) {
    console.error('RabbitMQ connection error:', error);
    setTimeout(rabbitMqConnect, 5000);
  }
};

// Message handlers
const handleRideRequest = (ride) => {
  console.log(`New ride request received: ${ride.id}`);
  pendingRides[ride.id] = ride;
};

const handleUserRoleUpdate = (user) => {
  if (user.role === 'driver') {
    drivers[user.userId] = {
      id: user.userId,
      username: user.username,
      available: true,
      currentRideId: null
    };
    console.log(`New driver registered: ${user.username}`);
  }
};

// Routes
app.get('/available-rides', authMiddleware, (req, res) => {
  const { role } = req.user;
  
  if (role !== 'driver') {
    return res.status(403).json({ message: 'Only drivers can view available rides' });
  }
  
  const availableRides = Object.values(pendingRides).filter(ride => ride.status === 'pending');
  
  res.json({ rides: availableRides });
});

app.post('/accept-ride/:rideId', authMiddleware, async (req, res) => {
  const { id: driverId, username: driverUsername, role } = req.user;
  const { rideId } = req.params;
  
  if (role !== 'driver') {
    return res.status(403).json({ message: 'Only drivers can accept rides' });
  }
  
  const ride = pendingRides[rideId];
  
  if (!ride) {
    return res.status(404).json({ message: 'Ride not found or already accepted' });
  }
  
  if (drivers[driverId]?.currentRideId) {
    return res.status(400).json({ message: 'You already have an active ride' });
  }
  
  try {
    // Update ride status in ride service
    await axios.post('http://ride-service:3001/internal/update-ride', {
      rideId,
      driverId,
      driverUsername,
      status: 'accepted'
    });
    
    // Update driver status
    drivers[driverId] = {
      ...drivers[driverId],
      available: false,
      currentRideId: rideId
    };
    
    // Remove from pending rides
    delete pendingRides[rideId];
    
    res.json({ 
      message: 'Ride accepted successfully', 
      rideId 
    });
  } catch (error) {
    console.error('Error accepting ride:', error.message);
    res.status(500).json({ message: 'Failed to accept ride' });
  }
});

app.post('/complete-ride/:rideId', authMiddleware, async (req, res) => {
  const { id: driverId, role } = req.user;
  const { rideId } = req.params;
  
  if (role !== 'driver') {
    return res.status(403).json({ message: 'Only drivers can complete rides' });
  }
  
  if (!drivers[driverId] || drivers[driverId].currentRideId !== rideId) {
    return res.status(403).json({ message: 'You are not assigned to this ride' });
  }
  
  try {
    // Update ride status in ride service
    await axios.post('http://ride-service:3001/internal/update-ride', {
      rideId,
      driverId,
      driverUsername: drivers[driverId].username,
      status: 'completed'
    });
    
    // Update driver status
    drivers[driverId] = {
      ...drivers[driverId],
      available: true,
      currentRideId: null
    };
    
    res.json({ 
      message: 'Ride completed successfully', 
      rideId 
    });
  } catch (error) {
    console.error('Error completing ride:', error.message);
    res.status(500).json({ message: 'Failed to complete ride' });
  }
});

app.get('/driver-status', authMiddleware, (req, res) => {
  const { id: driverId, role } = req.user;
  
  if (role !== 'driver') {
    return res.status(403).json({ message: 'Only drivers can check driver status' });
  }
  
  const driver = drivers[driverId] || {
    id: driverId,
    available: true,
    currentRideId: null
  };
  
  res.json({ driver });
});

// Start server
app.listen(PORT, async () => {
  console.log(`Driver service running on port ${PORT}`);
  await rabbitMqConnect();
});