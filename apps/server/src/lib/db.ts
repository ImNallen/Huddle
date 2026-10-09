import pg from 'pg'
import { config } from './config'
export const db = new pg.Pool({ connectionString: config.DATABASE_URL, max: 15 })
