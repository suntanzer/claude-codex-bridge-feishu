export function createLogger(name = 'ccmm') {
  const prefix = `[${name}]`;
  return {
    info(message) {
      console.log(`${prefix} ${message}`);
    },
    warn(message) {
      console.warn(`${prefix} ${message}`);
    },
    error(message) {
      console.error(`${prefix} ${message}`);
    },
    child(childName) {
      return createLogger(`${name}:${childName}`);
    },
  };
}
