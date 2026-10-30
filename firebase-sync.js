// ===== クラウド同期（Firebase Firestore + Googleログイン） =====
//
// LIFT LOG と同じ Firebase プロジェクトを使う。同じ Google アカウントでログインすれば、
// どの端末・ブラウザでも同じ記録が出る。保存先は LIFT LOG とは別の場所なので混ざらない。
//
// 設計の方針（LIFT LOG と同じ）:
//   - localStorage が主。クラウドは「もう一つの置き場所」として扱う
//   - 通信やSDKの読み込みに失敗しても、アプリ本体はそのまま動く
//
// MEAL LOG 固有の点:
//   - 記録は「1日＝1ドキュメント」（users/{uid}/mealDays/{YYYY-MM-DD}）。食事は1日に何件も増えるので、
//     1件ずつにすると同期のたびの読み取りが多くなりすぎる（無料枠は1日5万回）
//   - 毎回すべてを読み直さず、前回の同期のあとにクラウドで変わった日だけを読む（syncedAt で絞る）
//   - 同じ日を2つの端末で変えたときは、あとから変えた方が勝つ（日単位の上書き）
//   - 空にした日も [] のまま送る。これが「この日は消した」の印になる
//   - 目標・からだの値・マイ食品は users/{uid}/mealSettings/main の1つにまとめる
//
// Firebase の設定値（LIFT LOG と同じ）。公開されても問題ない値で、
// 安全性は Firestore のセキュリティルール（ログインした本人だけが自分の users/{uid}/ 以下を読み書きできる）で担保する。
const firebaseConfig = {
  apiKey: "AIzaSyDbdsmtBfoPnM5PxbMDMA91KzUPUUVpyhs",
  authDomain: "workout-app-27d33.firebaseapp.com",
  projectId: "workout-app-27d33",
  storageBucket: "workout-app-27d33.firebasestorage.app",
  messagingSenderId: "855945464580",
  appId: "1:855945464580:web:4d71627edc88e10fcbde51"
};

const SDK = "https://www.gstatic.com/firebasejs/12.18.0/";
const SYNC_KEY = "meal-log-sync-v1";   // { [uid]: { lastPull: ms } } アカウントごとの「どこまで読んだか」
// 他の端末の書き込みが届くまでの時間差を見込んで、少し前から読み直す（重なって読んでも結果は同じ）
const PULL_MARGIN = 60 * 1000;

const card       = document.getElementById("cloudCard");
const statusEl   = document.getElementById("cloudStatus");
const noteEl     = document.getElementById("cloudNote");
const signInBtn  = document.getElementById("cloudSignIn");
const signOutBtn = document.getElementById("cloudSignOut");
const syncBtn    = document.getElementById("cloudSyncNow");
const status = text => { statusEl.textContent = text; };
const note   = text => { noteEl.textContent = text; };

let A, F, auth, db;
let currentUid = null;
let syncing = false, queued = false, timer = null;

// SDKの読み込み。オフラインならここで失敗するが、アプリ本体には影響させない。
try {
  const [appMod, authMod, fsMod] = await Promise.all([
    import(SDK + "firebase-app.js"),
    import(SDK + "firebase-auth.js"),
    import(SDK + "firebase-firestore.js")
  ]);
  A = authMod;
  F = fsMod;
  const app = appMod.initializeApp(firebaseConfig);
  auth = A.getAuth(app);
  db = F.getFirestore(app);
  card.hidden = false;
  start();
} catch (e) {
  console.log("クラウド同期は利用できません（オフラインなど）:", e);
}

function start() {
  signInBtn.onclick = async () => {
    const provider = new A.GoogleAuthProvider();
    try {
      await A.signInWithPopup(auth, provider);
    } catch (e) {
      // ホーム画面に追加したアプリではポップアップが開けないことがあるので、画面遷移方式に切り替える
      if (String(e.code || "").includes("popup")) {
        await A.signInWithRedirect(auth, provider);
        return;
      }
      note("ログインできませんでした：" + (e.code || e.message));
    }
  };
  signOutBtn.onclick = () => A.signOut(auth);
  syncBtn.onclick = () => syncNow();

  A.getRedirectResult(auth).catch(() => {});

  A.onAuthStateChanged(auth, user => {
    currentUid = user ? user.uid : null;
    signInBtn.hidden  = !!user;
    signOutBtn.hidden = !user;
    syncBtn.hidden    = !user;

    if (user) {
      status(user.email || "ログイン中");
      note("記録や目標を変えるたびに、自動でクラウドへ反映されます。アプリを開き直したときに、ほかの端末の記録も取り込みます。");
      // 本体の save() から呼ばれる。目標の数字を打つたびに呼ばれるので、少し待ってまとめて送る
      window.cloudSync = () => { clearTimeout(timer); timer = setTimeout(syncNow, 1200); };
      syncNow();
    } else {
      status("未ログイン");
      note("Googleでログインすると、どの端末・ブラウザからでも同じ記録を見られます（LIFT LOG と同じアカウントでOK）。ログアウトしても、この端末の記録は消えません。");
      delete window.cloudSync;
    }
  });
}

async function syncNow() {
  if (!currentUid) return;
  if (syncing) { queued = true; return; }   // 同期中に呼ばれたら、終わってから一度だけやり直す
  syncing = true;
  clearTimeout(timer);
  try {
    status("同期中…");
    const changed = (await syncDays()) | (await syncSettings());
    window.mealApp.persist();
    if (changed) window.mealApp.render();
    const now = new Date().toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
    status(`✓ ${now} 同期`);
  } catch (e) {
    // 送れなかった分は印（dirtyDays / settingsDirty）が残っているので、次の同期で送られる
    status("同期エラー");
    note("同期できませんでした：" + (e.code || e.message));
    console.error(e);
  } finally {
    syncing = false;
    if (queued) { queued = false; syncNow(); }
  }
}

function loadSyncInfo() {
  try { return JSON.parse(localStorage.getItem(SYNC_KEY)) || {}; } catch (e) { return {}; }
}

// 日ごとの記録。先にクラウドの変更を取り込み、そのあと端末で変えた日を送る
async function syncDays() {
  const uid = currentUid;
  const s = window.mealApp.getState();
  const info = loadSyncInfo();
  const first = !info[uid];                 // この端末でこのアカウントの同期が初めてか
  const lastPull = first ? 0 : info[uid].lastPull;
  const col = F.collection(db, "users", uid, "mealDays");

  // クラウド → 端末：前回のあとに変わった日だけを読む（初めてなら全部）
  const snap = await F.getDocs(first ? col : F.query(col, F.where("syncedAt", ">", F.Timestamp.fromMillis(lastPull - PULL_MARGIN))));
  let changed = false, newest = lastPull;
  const seen = new Set();
  snap.forEach(d => {
    const r = d.data(), day = d.id;
    seen.add(day);
    if (r.syncedAt) newest = Math.max(newest, r.syncedAt.toMillis());
    if ((r.updatedAt || 0) > (s.dayAt[day] || 0)) {
      s.days[day] = r.entries || [];
      s.dayAt[day] = r.updatedAt;
      s.dirtyDays = s.dirtyDays.filter(x => x !== day);   // クラウドの方が新しいので、端末の分は送らない
      changed = true;
    }
  });

  // 初めての同期では、この端末にだけある日（ログイン前に付けた記録）も送る
  if (first) {
    for (const day of Object.keys(s.days)) {
      if (!seen.has(day) && !s.dirtyDays.includes(day)) {
        if (!s.dayAt[day]) s.dayAt[day] = Date.now();
        s.dirtyDays.push(day);
      }
    }
  }

  // 端末 → クラウド：変えた日を送る。Firestore の1回の書き込みは500件までなので分ける
  const sent = new Map();   // 送った日 → 送ったときの updatedAt
  const dirty = [...s.dirtyDays];
  for (let i = 0; i < dirty.length; i += 400) {
    const batch = F.writeBatch(db);
    for (const day of dirty.slice(i, i + 400)) {
      const at = s.dayAt[day] || Date.now();
      s.dayAt[day] = at;
      sent.set(day, at);
      batch.set(F.doc(col, day), { entries: s.days[day] || [], updatedAt: at, syncedAt: F.serverTimestamp() });
    }
    await batch.commit();
  }
  // 送っている間にまた変えた日は、印を残して次の同期で送り直す
  s.dirtyDays = s.dirtyDays.filter(day => sent.get(day) !== s.dayAt[day]);

  info[uid] = { lastPull: newest };
  localStorage.setItem(SYNC_KEY, JSON.stringify(info));
  return changed;
}

// 目標・からだの値・マイ食品。まとめて1つで、あとから変えた方が勝つ
async function syncSettings() {
  const s = window.mealApp.getState();
  const ref = F.doc(db, "users", currentUid, "mealSettings", "main");
  const snap = await F.getDoc(ref);
  const r = snap.exists() ? snap.data() : null;

  if (r && (r.updatedAt || 0) > s.settingsAt) {
    s.profile = { ...s.profile, ...(r.profile || {}) };
    s.mode = r.mode === "manual" ? "manual" : "auto";
    s.manual = r.manual || null;
    s.myFoods = r.myFoods || [];
    s.settingsAt = r.updatedAt;
    s.settingsDirty = false;
    return true;
  }
  if (!r || s.settingsDirty) {
    const at = s.settingsAt || Date.now();
    s.settingsAt = at;
    await F.setDoc(ref, { profile: s.profile, mode: s.mode, manual: s.manual, myFoods: s.myFoods, updatedAt: at });
    if (s.settingsAt === at) s.settingsDirty = false;   // 送っている間にまた変えたなら次で送り直す
  }
  return false;
}
