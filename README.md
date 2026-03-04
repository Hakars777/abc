# Soundsnap

Node.js app on Express for browsing and playing audio files from the `audio/` folder.

## Local start

```bash
npm install
npm start
```

Open `http://localhost:3000`.

## Deploy to Hostinger

1. Push the project to GitHub without `node_modules/`.
2. In Hostinger, connect the GitHub repository as a Node.js app.
3. Use `npm install` for install and `npm start` for start.
4. If needed, set `AUDIO_DIR` to a custom folder path in environment variables.

By default, the app uses the platform `PORT` and listens on `0.0.0.0`.
