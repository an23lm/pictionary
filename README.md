# Pictionary

A collaborative real-time drawing board for playing Pictionary with friends. Draw on a shared canvas and see strokes appear instantly on the other player's screen.

## Features

- Real-time collaborative drawing synced via Pusher
- Smooth bezier curve rendering with velocity-based stroke width
- Pressure-sensitive opacity (Force Touch trackpad + stylus)
- Animated dot grid background with cursor interaction
- Dark/light mode with system preference detection
- Safe zone indicator showing shared visible area across different screen sizes
- Remote player cursors
- Virtual cursor with button hover fill animations
- Deployable to Vercel

## Setup

1. **Install dependencies**

   ```bash
   npm install
   ```

2. **Configure Pusher**

   Create a free account at [pusher.com](https://pusher.com), create a Channels app, and copy the credentials into `.env.local`:

   ```bash
   cp .env.local.example .env.local
   ```

   ```
   PUSHER_APP_ID=your_app_id
   NEXT_PUBLIC_PUSHER_KEY=your_key
   PUSHER_SECRET=your_secret
   NEXT_PUBLIC_PUSHER_CLUSTER=your_cluster
   ```

3. **Run the dev server**

   ```bash
   npm run dev
   ```

4. **Open two browser tabs** to the same room URL and start drawing.

## Deploy

```bash
vercel
```

Set the four Pusher environment variables in your Vercel project settings.

## How to Play

1. Open the app -- you'll get a unique room URL
2. Click **Copy Link** and share it with a friend
3. One person draws, the other guesses
4. Hit the clear button to reset the board between rounds
