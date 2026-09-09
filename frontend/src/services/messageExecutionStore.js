import { runMessageAgent, seedMessageAgent, migrateMessageAgent } from './api';
import { createExecutionStore } from './executionStore';

// Legacy combined flow — kept so anything that still POSTs /message-run keeps working.
const store = createExecutionStore(runMessageAgent);
export const subscribe = store.subscribe;
export const getState = store.getState;
export const runExecution = store.runExecution;

// Stage 1 — seeding.
const seedStore = createExecutionStore(seedMessageAgent);
export const subscribeSeed = seedStore.subscribe;
export const getSeedState = seedStore.getState;
export const runSeed = seedStore.runExecution;

// Stage 2 — migration.
const migrateStore = createExecutionStore(migrateMessageAgent);
export const subscribeMigrate = migrateStore.subscribe;
export const getMigrateState = migrateStore.getState;
export const runMigrate = migrateStore.runExecution;
