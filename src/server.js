import 'dotenv/config';
import app from './app.js';

const port = Number.parseInt(process.env.PORT ?? '3000', 10);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('Invalid PORT configuration.');
  process.exit(1);
}

app.listen(port, () => {
  console.log(`TRIVON Auth API is running on port ${port}`);
});