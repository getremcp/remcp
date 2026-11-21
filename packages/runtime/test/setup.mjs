process.env.NODE_ENV = 'test';

// Runtime default/telemetry tests must not inherit the owner's persistent
// opt-out settings from the shell or managed agent. This runs only in the
// test-process bootstrap; production keeps the owner's opt-out untouched.
// Opt-out regression fixtures set the variables after this bootstrap.
delete process.env.REMCP_RUNTIME_DISABLE_TELEMETRY;
delete process.env.REMCP_RUNTIME_TELEMETRY;
