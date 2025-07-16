It's a client for https://barbarian.men that I hacked together for my own convenience. Adds searching, date filtering and sorting, auto-resume from last playback position, chat overlay/sidebar/off options, and a resizable UI.

Don't use the server, just run the Electron app (see Releases). I run the server because I'm weird and want to use it from my Fire TV which barely handles the site.

```bash
# Setup
npm install

# Run the Electron app
npm run electron

# Electron dev
npm run electron-dev

# Package Electron app
npm pack
npm pack-mac
npm pack-linux

# Run as a server
npm start

# Dev mode
npm run dev
```
