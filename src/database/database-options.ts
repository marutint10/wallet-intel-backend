export const shouldUseDatabaseSsl = (
  databaseUrl: string,
  configuredSsl?: boolean,
): boolean => {
  if (configuredSsl !== undefined) {
    return configuredSsl;
  }

  const parsed = new URL(databaseUrl);

  if (parsed.searchParams.get('sslmode') === 'disable') {
    return false;
  }

  if (parsed.searchParams.get('sslmode') === 'require') {
    return true;
  }

  return parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1';
};

export const getDatabaseSslOption = (
  databaseUrl: string,
  configuredSsl?: boolean,
): boolean | { rejectUnauthorized: boolean } => {
  return shouldUseDatabaseSsl(databaseUrl, configuredSsl)
    ? { rejectUnauthorized: false }
    : false;
};

export const parseDatabaseSslEnv = (): boolean | undefined => {
  const value = process.env.DATABASE_SSL;
  if (value === undefined) {
    return undefined;
  }

  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
};
