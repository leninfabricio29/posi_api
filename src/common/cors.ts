export function corsOrigins(): string[] {
  const raw = process.env.CORS_ORIGINS || 'http://localhost:3000';
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
