import { createApp } from './bootstrap';
import { loadConfig } from './config';

async function main(): Promise<void> {
  const config = loadConfig();
  const app = await createApp(config);
  await app.listen(config.PORT, config.HOST);
  // eslint-disable-next-line no-console
  console.log(`DSCC API listening on http://${config.HOST}:${config.PORT}/api/v1 (${config.NODE_ENV}, SMS=${config.SMS_PROVIDER}, NID=${config.NID_VERIFICATION_PROVIDER})`);
}

void main();
