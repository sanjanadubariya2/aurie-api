import dns from 'node:dns'
import mongoose from 'mongoose'
import { config } from './config.js'

mongoose.set('strictQuery', true)

// Some Windows setups (a VPN/security tool advertising a loopback DNS stub,
// commonly) leave Node's resolver pointed at 127.0.0.1 with nothing listening
// there, which breaks the SRV/TXT lookups mongodb+srv:// needs before the
// connection even reaches the network. Public resolvers as a fallback fix it
// without depending on the host's network config being correct.
if (dns.getServers().every((s) => s === '127.0.0.1' || s === '::1')) {
  dns.setServers(['1.1.1.1', '8.8.8.8', ...dns.getServers()])
}

export async function connectDb() {
  await mongoose.connect(config.mongodbUri)
  console.log('db connected')
}

export async function disconnectDb() {
  await mongoose.disconnect()
}
