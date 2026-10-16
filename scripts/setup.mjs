import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

if (existsSync('.env')) {
  console.log('.env 已存在，保留现有配置。');
} else {
  const config = readFileSync('.env.example', 'utf8').replace(
    'replace-with-a-long-random-password', randomBytes(18).toString('base64url'),
  );
  writeFileSync('.env', config, { mode: 0o600 });
  console.log('已生成 .env。管理员用户名和随机密码见 RELAY_ADMIN_USER / RELAY_ADMIN_PASSWORD。');
}
