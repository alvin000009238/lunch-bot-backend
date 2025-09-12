const { spawn } = require('child_process');
const request = require('supertest');

let serverProcess;

beforeAll(done => {
  serverProcess = spawn('node', ['index.js'], {
    env: {
      ...process.env,
      PORT: 4000,
      CHANNEL_ACCESS_TOKEN: 'test',
      CHANNEL_SECRET: 'test',
      DATABASE_URL: 'postgres://user:pass@localhost:5432/testdb'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const onData = (data) => {
    const msg = data.toString();
    if (msg.includes('伺服器正在')) {
      serverProcess.stdout.off('data', onData);
      done();
    }
  };
  serverProcess.stdout.on('data', onData);
});

afterAll(() => {
  if (serverProcess) {
    serverProcess.kill();
  }
});

test('GET / responds with server message', async () => {
  const res = await request('http://localhost:4000').get('/');
  expect(res.status).toBe(200);
  expect(res.text).toBe('伺服器已啟動！');
});
