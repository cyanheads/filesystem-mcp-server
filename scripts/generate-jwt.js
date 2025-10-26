#!/usr/bin/env node

import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';

dotenv.config();

const secretKey = process.env.MCP_AUTH_SECRET_KEY;

if (!secretKey) {
    console.error('Error: MCP_AUTH_SECRET_KEY not found in environment variables.');
    process.exit(1);
}

// Simple payload for JWT
const payload = {
    cid: 'test-client', // client_id
    scp: ['read', 'write'], // scopes
    sub: 'test-session', // subject/session id
    iat: Math.floor(Date.now() / 1000), // issued at
    exp: Math.floor(Date.now() / 1000) + (60 * 60), // expires in 1 hour
};

try {
    const token = jwt.sign(payload, secretKey);
    console.log('Generated JWT Token:');
    console.log(token);
} catch (error) {
    console.error('Error generating JWT:', error);
    process.exit(1);
}