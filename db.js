/**
 * Mongo connection helper.
 * Caches the client/db on the global object so warm serverless invocations
 * (Vercel) reuse the same connection instead of opening a new one per request.
 */
import { MongoClient } from 'mongodb';

const uri    = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB || 'drcv';

export async function getDb() {
  if (!uri) throw new Error('MONGODB_URI not set');

  if (!global._drcvMongoClient) {
    global._drcvMongoClient = new MongoClient(uri);
  }
  const client = global._drcvMongoClient;

  // mongodb driver v6: topology is undefined until connect() is called once
  if (!client.topology || !client.topology.isConnected()) {
    await client.connect();
  }

  return client.db(dbName);
}

export function leadsCollection(db) {
  return db.collection('leads');
}
