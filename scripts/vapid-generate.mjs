// v4 §4.2: `npm run vapid:generate` prints a new Web Push (VAPID) key pair for .env. Run it once per installation;
// changing the keys later makes every existing browser subscription stop working (people turn push on again).
// The private key is printed only to this terminal — never commit it or paste it anywhere public.
import webpush from "web-push";

const { publicKey, privateKey } = webpush.generateVAPIDKeys();
console.log("# Add these to .env (keep VAPID_PRIVATE_KEY secret). VAPID_SUBJECT: mailto: the club's email address.");
console.log(`VAPID_PUBLIC_KEY="${publicKey}"`);
console.log(`VAPID_PRIVATE_KEY="${privateKey}"`);
console.log('VAPID_SUBJECT="mailto:"');
console.log("# Push also needs APP_URL to be https:// (browsers only allow push on HTTPS). Restart the app and the worker after editing .env.");
