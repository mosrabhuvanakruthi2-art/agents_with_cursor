const logger = require('../../utils/logger');

const AgentStatus = {
  PENDING: 'PENDING',
  RUNNING: 'RUNNING',
  SUCCESS: 'SUCCESS',
  FAILED: 'FAILED',
};

class BaseAgent {
  constructor(name) {
    this.name = name;
    this.status = AgentStatus.PENDING;
    this.startedAt = null;
    this.completedAt = null;
    this.result = null;
    this.error = null;
  }

  getName() {
    return this.name;
  }

  setStatus(status) {
    this.status = status;
    if (status === AgentStatus.RUNNING) {
      this.startedAt = new Date().toISOString();
    }
    if (status === AgentStatus.SUCCESS || status === AgentStatus.FAILED) {
      this.completedAt = new Date().toISOString();
    }
  }

  /**
   * Override in subclasses. Receives MigrationContext and returns agent-specific result.
   */
  async execute(_context) {
    throw new Error(`${this.name}: execute() must be implemented by subclass`);
  }

  async run(context) {
    const execLogger = logger.child({
      agent: this.name,
      executionId: context.executionId,
    });

    this.setStatus(AgentStatus.RUNNING);
    execLogger.info(`Agent started`);

    try {
      this.result = await this.execute(context);
      this.setStatus(AgentStatus.SUCCESS);
      execLogger.info(`Agent completed successfully`);
      return this.result;
    } catch (err) {
      this.error = err.message;
      this.setStatus(AgentStatus.FAILED);
      execLogger.error(`Agent failed: ${err.message}`);
      throw err;
    }
  }

  toJSON() {
    return {
      name: this.name,
      status: this.status,
      startedAt: this.startedAt,
      completedAt: this.completedAt,
      result: this.result,
      error: this.error,
    };
  }
}

module.exports = { BaseAgent, AgentStatus };
