'use strict';

const app = require('./server');

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server: 0.0.0.0:${PORT}`);
});
