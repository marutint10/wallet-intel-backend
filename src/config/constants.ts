/**
 * Maximum number of transactions to fetch per wallet from external providers.
 * Applies during both initial full-history ingestion and incremental refresh.
 * Keeps memory and latency predictable during build and testing.
 */
export const TX_FETCH_LIMIT = 500;
