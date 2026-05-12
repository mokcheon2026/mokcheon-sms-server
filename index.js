const express = require("express");
const fetch = require("node-fetch");
const admin = require("firebase-admin");

const app = express();
app.use(express.json());

// CORS 설정
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// Firebase 초기화
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// 알리고 설정
const ALIGO_KEY = process.env.ALIGO_KEY;
const ALIGO_ID = process.env.ALIGO_ID;
const ALIGO_SENDER = process.env.ALIGO_SENDER;

// SMS 발송 함수
async function sendSMS(receiver, msg) {
  const params = new URLSearchParams();
  params.append("key", ALIGO_KEY);
  params.append("user_id", ALIGO_ID);
  params.append("sender", ALIGO_SENDER);
  params.append("receiver", receiver.replace(/-/g, ""));
  params.append("msg", msg);
  params.append("testmode_yn", "N");

  const res = await fetch("https://apis.aligo.in/send/", {
    method: "POST",
    body: params,
  });
  const result = await res.json();
  console.log("SMS 결과:", JSON.stringify(result));
  return result;
}

// ─── 외출·외박 신청 처리 ───────────────────────────────────────────────────
app.post("/onLeaveRequest", async (req, res) => {
  try {
    const data = req.body;
    const { studentName, room, type, date, timeOut, timeIn, returnDate, reason, parentPhone, studentId } = data;

    if (!parentPhone) return res.json({ success: false, message: "학부모 번호 없음" });

    const approveUrl = `https://mokcheon-sms-server.onrender.com/approve?id=${data.docId}&action=approve`;
    const rejectUrl = `https://mokcheon-sms-server.onrender.com/approve?id=${data.docId}&action=reject`;

    const timeInfo = type === "외출" && timeOut && timeIn ? ` (${timeOut}~${timeIn})` : type === "외박" ? ` ~ ${returnDate}` : "";
    const msg = `[목천고 기숙사] ${studentName}(${room}호) ${type} 신청\n날짜: ${date}${timeInfo}\n사유: ${reason}\n\n✅ 승인: ${approveUrl}\n❌ 거절: ${rejectUrl}`;

    await sendSMS(parentPhone, msg);
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── 학부모 승인/거절 처리 ─────────────────────────────────────────────────
app.get("/approve", async (req, res) => {
  const { id, action } = req.query;
  if (!id || !action) return res.send("잘못된 요청입니다.");

  try {
    const snap = await db.collection("leaveRequests").doc(id).get();
    if (!snap.exists) return res.send("해당 신청을 찾을 수 없습니다.");

    const data = snap.data();

    // 교사가 이미 승인완료한 건은 학부모 재클릭 무시
    if (data.teacherApproved === true || data.status === "승인완료") {
      return res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:60px">
        <h2>✅ 이미 처리된 신청입니다</h2>
        <p>${data.studentName} 학생의 ${data.type} 신청은 이미 교사 승인이 완료되었습니다.</p>
        <p style="color:#888;font-size:14px">더 이상 변경할 수 없습니다.</p>
      </body></html>`);
    }

    const approved = action === "approve";
    await db.collection("leaveRequests").doc(id).update({
      parentApproved: approved,
      status: approved ? "교사승인대기" : "부모거절",
    });

    // 교사에게 문자 발송
    const teacherSnap = await db.collection("users").where("role", "==", "teacher").get();
    for (const t of teacherSnap.docs) {
      const teacher = t.data();
      if (teacher.phone) {
        await sendSMS(teacher.phone, `[목천고 기숙사] ${data.studentName} ${data.type} 신청 학부모 ${approved ? "✅ 승인" : "❌ 거절"} — 교사 최종 확인 바랍니다.`);
      }
    }

    res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:60px">
      <h2>${approved ? "✅ 승인 완료" : "❌ 거절 완료"}</h2>
      <p>${data.studentName} 학생의 ${data.type} 신청을 ${approved ? "승인" : "거절"}했습니다.</p>
    </body></html>`);
  } catch (e) {
    console.error(e);
    res.send("처리 중 오류가 발생했습니다.");
  }
});

// ─── 교사 대리 신청 알림 ───────────────────────────────────────────────────
app.post("/onProxyLeave", async (req, res) => {
  try {
    const { studentName, room, type, date, timeOut, timeIn, returnDate, reason, parentPhone } = req.body;

    if (!parentPhone) return res.json({ success: false, message: "학부모 번호 없음" });

    const timeInfo = type === "외출" && timeOut && timeIn ? ` (${timeOut}~${timeIn})` : type === "외박" ? ` ~ ${returnDate}` : "";
    const msg = `[목천고 기숙사] ${studentName}(${room}호) ${type} 안내\n날짜: ${date}${timeInfo}\n사유: ${reason}\n\n담당 교사가 직접 처리한 건으로 별도 승인이 필요 없습니다.`;

    await sendSMS(parentPhone, msg);
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: e.message });
  }
});
app.post("/onPointAdded", async (req, res) => {
  try {
    const { studentName, room, type, point, reason, parentPhone, penalties } = req.body;

    if (!parentPhone) return res.json({ success: false, message: "학부모 번호 없음" });

    const sign = type === "상점" ? "+" : "-";
    let msg = `[목천고 기숙사] ${studentName}(${room}호) ${type} ${sign}${point}점\n사유: ${reason}\n누적 벌점: ${penalties || 0}점`;

    // 벌점 경고
    const p = parseInt(penalties || 0);
    if (p >= 50) msg += `\n🚨 벌점 50점 초과 — 3달 퇴사 조치 대상입니다.`;
    else if (p >= 45) msg += `\n⚠️ 벌점 45점 이상 — 50점 초과 시 3달 퇴사입니다.`;
    else if (p >= 30) msg += `\n🚨 벌점 30점 초과 — 1주 퇴사 조치 대상입니다.`;
    else if (p >= 25) msg += `\n⚠️ 벌점 25점 이상 — 30점 초과 시 1주 퇴사입니다.`;

    await sendSMS(parentPhone, msg);
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// 헬스체크
app.get("/", (req, res) => res.send("목천고 SMS 서버 정상 작동 중 ✅"));

// 서버 외부 IP 확인
app.get("/myip", async (req, res) => {
  const r = await fetch("https://ifconfig.me");
  const ip = await r.text();
  res.send(`서버 외부 IP: ${ip}`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`SMS 서버 실행 중: 포트 ${PORT}`);

  // 슬립 방지 - 5분마다 자기 자신에게 핑
  setInterval(() => {
    fetch("https://mokcheon-sms-server.onrender.com")
      .then(() => console.log("슬립 방지 핑 완료"))
      .catch(() => {});
  }, 5 * 60 * 1000);
});
