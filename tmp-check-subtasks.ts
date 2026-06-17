import { bootstrapDatabase } from './api/lib/dbBootstrap.ts';
import { getDatabase, closeDatabase } from './api/db/sqlite.ts';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'df-debug-'));
process.env.DEVFLEET_DB_FILE = path.join(dir, 'devfleet.db');
process.env.JWT_SECRET = 'x';
bootstrapDatabase();
const db = getDatabase();
const rows = db.prepare("PRAGMA table_info(sub_tasks)").all() as Array<{ name:string }>;
console.log(rows.map((r) => r.name).join(','));
closeDatabase();
