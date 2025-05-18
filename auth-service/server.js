//ride-sharing/auth-service/server.js
const bodyParser = require('body-parser');
const express = require('express');
const amqp = require('amqplib');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const PORT = 3000;
const JWT_SECRET = 'supanigga';
const app = express();

const users = {
    'user1' : {
        id: '1',
        username: 'user1',
        password: 'lumbalumbakudus',
        role: null
    },
    'user2' : {
        id: '2',
        username: 'user2',
        password: 'kudalumpingboyolali',
        role: null
    }
}

app.use(bodyParser.json());

let channel;
const rabbitMqConnect = async () => {
    try {
        const connection = await amqp.connect(`amqp://${process.env.RABBITMQ_HOST || 'localhost'}`);
        channel = await connection.createChannel();

        await channel.assertExchange('user_events', 'topic', { durable: false});

        console.log('Connected to RabbitMQ');
    } catch (error) {
        console.error('RabbitMQ connecion error:', error);
        setTimeout(rabbitMqConnect, 5000);
    }
}

app.post('/register', async (req, res) => {
    const { username, password } = req.body

    if (users[username]) {
        return res.status(400).send('Username already exists');
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const userId = Date.now().toString();

    users[username] = {
        id: userId,
        username,
        password: hashedPassword,
        role: null
    };

    res.status(201).send('User registered successfully', userId);
})

app.post('/login', async (req, res) => {
    const { username, password } = req.body;

    const user = users[username];
    if(!user || !(await bcrypt.compare(password, user.password))) {
        return res.status(401).send({message: "Invalid credentials"});
    }

    const token = jwt.sign(
        { id: user.id, username: user.username, role: user.role },
        JWT_SECRET,
        { expiresIn: '1h' }
    )

    res.status(200).json({
        message: 'Login successful',
        token,
        username: user.name,
        role: user.role
    })
})

app.post('/set-role', async (req, res) => {
    const {username, role} = req.body;
    const token = req.headers.authorization?.split(' ')[1];

    if (!token) {
        return res.status(401).send({ message: 'Unauthorized' });
    }

    try {
        const decoded = jwt.verify(token, JWT_SECRET);

        if (decoded.username !== username) {
            return res.status(401).send({ message: 'Unauthorized' });
        }

        if (!['rider', 'driver'].includes(role)) {
            return res.status(400).send({ message: 'Invalid role. Must be "rider" or "driver"'  });
        }

        users[username].role = role;

        const newToken = jwt.sign(
            { id: users[username].id, username, role},
            JWT_SECRET,
            { expiresIn: '1h' }
        )

        if(channel) {
            channel.publish(
                'user_events',
                'user.role.updated',
                Buffer.from(JSON.stringify({
                    username,
                    role
                }))
            )
        }

        res.json({
            message: 'Role updated successfully',
            token: newToken,
            role
        })
    } catch (error) {
        res.status(401).send({ message: 'Invalid or expired token' });
    }
})

app.post('/verify-token', (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];

    if(!token){
        return res.status(401).send({ message: 'Unauthorized' });
    }

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        res.json({
            valid: true,
            user: decoded
        })
    } catch (error) {
        res.json({
            valid: false
        })
    }
})

app.listen(PORT, async () => {
    console.log(`Auth service listening on port ${PORT}`);
    await rabbitMqConnect();
});