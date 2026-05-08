const fs = require('fs');
const file = 'components/GameView.tsx';
let txt = fs.readFileSync(file, 'utf8');

const startStr = '// --- Collision Handling ---';
const endStr = 'app.ticker.add(tickerCb);';

const block = `// --- Collision Handling ---
        if (cfg.collision_handlers) {
            const now = performance.now();
            cfg.collision_handlers.forEach(handler => {
               if (!handler.between || handler.between.length < 2) return;
               const idA = handler.between[0];
               const idB = handler.between[1];
               const entA = entitiesRef.current[idA];
               const entB = entitiesRef.current[idB];
               
               if (!entA || !entB || !entA.visible || !entB.visible) return;
               
               const avgPressure = (normalizedPrs.left + normalizedPrs.right) / 2;

               // DODGE_PHASE early-exit penetration lock
               if (handler.on_match_logic === 'DODGE_PHASE' && avgPressure < 0.05) {
                   return; // Do not trigger collision logic; objects bypass natively
               }
               
               const b1 = entA.getBounds();
               const b2 = entB.getBounds();
               const isOverlapping = b1.x < b2.x + b2.width && b1.x + b1.width > b2.x &&
                                     b1.y < b2.y + b2.height && b1.y + b1.height > b2.y;
                                     
               if (isOverlapping) {
                   const collisionKey = \`\${idA}_\${idB}\`;
                   const lastTime = collisionCooldownRef.current[collisionKey] || 0;
                   if (now - lastTime > 500) { // 500ms cooldown for responsive bounces
                       collisionCooldownRef.current[collisionKey] = now;
                       
                       // Velocity Reflection (PULSE)
                       if (handler.on_match_logic === 'PULSE') {
                           [idA, idB].forEach(id => {
                               if (entityPhysicsRef.current[id]) {
                                   let prevVy = entityPhysicsRef.current[id].vy;
                                   if (prevVy !== 0) {
                                       let newVy = prevVy * -1;
                                       if (avgPressure > 0.6) {
                                           newVy *= 2;
                                       }
                                       entityPhysicsRef.current[id].vy = newVy;
                                   }
                               }
                           });
                       }
                       
                       if (handler.on_match_logic === 'DODGE_PHASE') {
                           // If reached here, pressure is >= 0.05 (hit occurred)
                           scoreRef.current -= 1;
                           gsap.to(entA.scale, { x: 1.5, y: 1.5, duration: 0.1, yoyo: true, repeat: 1 });
                       } else if (handler.on_match_logic === 'SCORE_HIT') {
                           scoreRef.current += 1;
                           gsap.to(entA.scale, { x: 1.5, y: 1.5, duration: 0.1, yoyo: true, repeat: 1 });
                           gsap.to(entB.scale, { x: 1.5, y: 1.5, duration: 0.1, yoyo: true, repeat: 1 });
                       } else if (handler.on_match_logic === 'RANDOM_RECOLOR') {
                           scoreRef.current += 1;
                           const newColor = Math.random() * 0xFFFFFF;
                           entA.children.forEach(c => { if ('tint' in c) (c as any).tint = newColor; });
                           entB.children.forEach(c => { if ('tint' in c) (c as any).tint = newColor; });
                       }
                       
                       if (handler.penalty_logic === 'DEDUCT_SCORE') {
                           scoreRef.current -= 1;
                       }
                       
                       if (instructionTextRef.current) {
                           instructionTextRef.current.text = \`[\${cfg.metadata.game_name}] 模式: \${cfg.metadata.interaction_type} | 分數: \${Math.max(0, scoreRef.current)}\`;
                       }
                   }
               }
            });
        }
        
      };

      `;

const sIdx = txt.indexOf(startStr);
const eIdx = txt.indexOf(endStr);
if (sIdx > -1 && eIdx > -1) {
   txt = txt.substring(0, sIdx) + block + txt.substring(eIdx);
   fs.writeFileSync(file, txt);
}
