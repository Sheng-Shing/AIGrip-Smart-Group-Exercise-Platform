import path from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

import fs from 'fs';

export default defineConfig(() => {
  return {
    server: {
      port: 8000,
      host: 'localhost',
      proxy: {}, // Empty proxy to satisfy some internal checks if needed
    },
    plugins: [
      react(),
      {
        name: 'save-generated-image',
        configureServer(server) {
          server.middlewares.use('/api/list-images', (req, res, next) => {
            if (req.method === 'GET') {
              try {
                const dir = path.resolve(process.cwd(), 'public/assets/generated');
                if (!fs.existsSync(dir)) {
                  res.statusCode = 200;
                  res.end(JSON.stringify([]));
                  return;
                }
                const files = fs.readdirSync(dir)
                  .filter(file => /\.(png|jpg|jpeg|webp)$/i.test(file))
                  .map(file => `/assets/generated/${file}`);

                res.setHeader('Content-Type', 'application/json');
                res.statusCode = 200;
                res.end(JSON.stringify(files.reverse())); // Newest first
              } catch (err) {
                res.statusCode = 500;
                res.end(JSON.stringify({ error: String(err) }));
              }
              return;
            }
            next();
          });

          server.middlewares.use('/api/save-image', (req, res, next) => {
            if (req.method === 'POST') {
              let body = '';
              req.on('data', chunk => { body += chunk.toString(); });
              req.on('end', () => {
                try {
                  const { imageData, filename } = JSON.parse(body);
                  const base64Data = imageData.replace(/^data:image\/\w+;base64,/, "");
                  const buffer = Buffer.from(base64Data, 'base64');

                  const dir = path.resolve(process.cwd(), 'public/assets/generated');
                  if (!fs.existsSync(dir)) {
                    fs.mkdirSync(dir, { recursive: true });
                  }

                  const filePath = path.join(dir, filename);
                  fs.writeFileSync(filePath, buffer);

                  res.statusCode = 200;
                  res.end(JSON.stringify({ success: true, path: `/assets/generated/${filename}` }));
                } catch (err) {
                  res.statusCode = 500;
                  res.end(JSON.stringify({ success: false, error: String(err) }));
                }
              });
              return;
            }
            next();
          });
        }
      }
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      }
    }
  };
});
