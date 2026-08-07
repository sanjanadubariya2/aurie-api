import jwt from 'jsonwebtoken'
import { config } from '../config.js'

// Keep the payload thin — an id and a role. A JWT is signed, not encrypted;
// anyone holding it can read the contents, so nothing private goes in here.
export const signToken = (customer) =>
  jwt.sign({ sub: customer._id.toString(), role: customer.role }, config.jwtSecret, {
    expiresIn: '30d',
    issuer: 'aurie',
  })

export const verifyToken = (token) => jwt.verify(token, config.jwtSecret)
