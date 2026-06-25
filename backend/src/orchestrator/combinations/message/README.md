# message combinations

One file per Slack/Teams/Google-Chat migration pair, auto-loaded by
`agentRegistry.loadCombinations()` (same as `mail/` and `content/`).
Each registers `{ TestDataAgent, MigrationAgent, ValidationAgent }` for
`('message', sourcePlatform, destinationPlatform)`. The orchestrator
(`MessageAgentOrchestrator`) resolves the agent set per combination.
