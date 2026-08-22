import { Hono } from 'hono';
import { createClient } from '@libsql/client';

export const tursoClient = createClient({
	url: process.env.TURSO_DATABASE_URL!,
	authToken: process.env.TURSO_AUTH_TOKEN,
});
const app = new Hono();

app.get('/', (c) => {
	return c.text('Hello Hono!');
});

export default app;
