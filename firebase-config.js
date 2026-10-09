/* Firebase web config for Gran Care accounts (Firebase console > Project settings > Your apps > Web).
   These values identify the project; they are not secrets. Access is enforced by firestore.rules.
   Leave apiKey empty to build the app without accounts (data stays on the phone). */
window.GC_FIREBASE_CONFIG = {
  apiKey: 'AIzaSyAdREoLAptFszXTORbce5l7Qb_bn4A1qkU',
  authDomain: 'grancare-10030.firebaseapp.com',
  projectId: 'grancare-10030',
  storageBucket: 'grancare-10030.firebasestorage.app',
  messagingSenderId: '906531283114',
  appId: '1:906531283114:web:284186ecd3c2aeed5e30d3'
};

/* Page the son's alert SMS links to ("I have seen this"). Free: published from this repo's
   site/ folder by GitHub Pages (.github/workflows/pages.yml). */
window.GC_SEEN_BASE = 'https://shyxm-07.github.io/GranCare/seen/';
