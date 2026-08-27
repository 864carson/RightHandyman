module.exports = {
  testEnvironment: 'node',
  collectCoverageFrom: [
    'src/**/*.js',
    '!src/server.js'
  ],
  coveragePathIgnorePatterns: ['/node_modules/'],
  verbose: true
};
