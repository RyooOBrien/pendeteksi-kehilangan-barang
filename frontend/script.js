let model = null;
let stream = null;
let isMonitoring = false;
let animationId = null;

let missingStartTime = null;
let alertSent = false;

const LOST_DELAY_SECONDS = 8;
const CONFIDENCE_LIMIT = 0.45;

const video = document.getElementById("video");
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");

const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");

const ownerNameInput = document.getElementById("ownerName");
const ownerPhoneInput = document.getElementById("ownerPhone");
const targetItemInput = document.getElementById("targetItem");
const locationInput = document.getElementById("location");

const modelStatus = document.getElementById("modelStatus");
const alertBox = document.getElementById("alertBox");
const statusTitle = document.getElementById("statusTitle");
const statusText = document.getElementById("statusText");

const itemInfo = document.getElementById("itemInfo");
const detectInfo = document.getElementById("detectInfo");
const missingTime = document.getElementById("missingTime");
const notifStatus = document.getElementById("notifStatus");
const historyList = document.getElementById("historyList");

const itemLabels = {
  "laptop": "Laptop",
  "cell phone": "Handphone",
  "backpack": "Tas / Backpack",
  "handbag": "Tas Tangan",
  "bottle": "Botol",
  "book": "Buku"
};

async function loadModel() {
  try {
    modelStatus.textContent = "Memuat model AI...";
    model = await cocoSsd.load();
    modelStatus.textContent = "Model AI siap";
  } catch (error) {
    console.error(error);
    modelStatus.textContent = "Model gagal dimuat";
  }
}

function setStatus(type, title, text) {
  alertBox.className = `alert ${type}`;
  statusTitle.textContent = title;
  statusText.textContent = text;
}

function getCurrentTime() {
  const now = new Date();
  return now.toLocaleTimeString("id-ID", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function addHistory(message) {
  if (historyList.children.length === 1 && historyList.children[0].textContent.includes("Belum ada")) {
    historyList.innerHTML = "";
  }

  const li = document.createElement("li");
  li.textContent = `[${getCurrentTime()}] ${message}`;
  historyList.prepend(li);
}

async function startCamera() {
  stream = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: "environment",
      width: { ideal: 1280 },
      height: { ideal: 720 }
    },
    audio: false
  });

  video.srcObject = stream;

  return new Promise((resolve) => {
    video.onloadedmetadata = () => {
      video.play();

      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;

      resolve();
    };
  });
}

function stopCamera() {
  if (stream) {
    stream.getTracks().forEach(track => track.stop());
    stream = null;
  }

  if (animationId) {
    cancelAnimationFrame(animationId);
    animationId = null;
  }

  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

function drawPredictions(predictions, targetItem) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  predictions.forEach(prediction => {
    if (prediction.score < CONFIDENCE_LIMIT) return;

    const [x, y, width, height] = prediction.bbox;
    const isTarget = prediction.class === targetItem;

    ctx.strokeStyle = isTarget ? "#22c55e" : "#38bdf8";
    ctx.lineWidth = 3;
    ctx.strokeRect(x, y, width, height);

    ctx.fillStyle = isTarget ? "#22c55e" : "#38bdf8";
    ctx.font = "16px Arial";
    ctx.fillText(
      `${prediction.class} ${(prediction.score * 100).toFixed(0)}%`,
      x,
      y > 20 ? y - 8 : y + 20
    );
  });
}

function normalizePhoneNumber(phone) {
  let cleaned = phone.trim();

  // Hapus spasi, strip, kurung, dan tanda +
  cleaned = cleaned.replace(/[\s\-()+]/g, "");

  // Kalau mulai dari 08, ubah jadi 628
  if (cleaned.startsWith("08")) {
    cleaned = "62" + cleaned.substring(1);
  }

  // Kalau mulai dari 8 langsung, ubah jadi 628
  if (cleaned.startsWith("8")) {
    cleaned = "62" + cleaned;
  }

  return cleaned;
}

async function sendLostItemNotification() {
  const data = {
    ownerName: ownerNameInput.value.trim(),
    phone: normalizePhoneNumber(ownerPhoneInput.value),
    itemName: itemLabels[targetItemInput.value],
    itemClass: targetItemInput.value,
    location: locationInput.value.trim(),
    time: getCurrentTime()
  };

  notifStatus.textContent = "Mengirim...";

  try {
    const response = await fetch("http://localhost:3000/api/lost-item", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(data)
    });

    if (!response.ok) {
      throw new Error("Backend belum aktif atau gagal mengirim notifikasi");
    }

    const result = await response.json();

    console.log("DATA YANG DIKIRIM KE BACKEND:", data);
    console.log("RESPON BACKEND:", result);

    const status = result.data?.notificationStatus || "SIMULASI_TERKIRIM";
    const message = result.data?.notificationMessage || "";

    if (status === "SIMULASI_TERKIRIM") {
      notifStatus.textContent = "Simulasi terkirim";
    } else if (status === "WHATSAPP_TERKIRIM") {
      notifStatus.textContent = "WhatsApp terkirim";
    } else if (status === "WHATSAPP_GAGAL") {
      notifStatus.textContent = "WhatsApp gagal";
      console.log("ALASAN WHATSAPP GAGAL:", message);
    } else {
      notifStatus.textContent = status;
    }

    addHistory(
      `${data.itemName} hilang di ${data.location}. Status notifikasi: ${notifStatus.textContent}.`
    );

  } catch (error) {
    console.warn(error.message);

    notifStatus.textContent = "Backend gagal";
    addHistory(
      `${data.itemName} hilang di ${data.location}. Backend belum aktif atau gagal menerima laporan.`
    );
  }
}

async function detectLoop() {
  if (!isMonitoring || !model) return;

  const targetItem = targetItemInput.value;
  const predictions = await model.detect(video);

  drawPredictions(predictions, targetItem);

  const targetDetected = predictions.some(prediction => {
    return prediction.class === targetItem && prediction.score >= CONFIDENCE_LIMIT;
  });

  if (targetDetected) {
    missingStartTime = null;
    alertSent = false;

    detectInfo.textContent = "Terdeteksi";
    missingTime.textContent = "0 detik";
    notifStatus.textContent = "Belum dikirim";

    setStatus(
      "safe",
      "Barang Aman",
      `${itemLabels[targetItem]} masih terdeteksi di area pemantauan.`
    );
  } else {
    if (!missingStartTime) {
      missingStartTime = Date.now();
    }

    const elapsedSeconds = Math.floor((Date.now() - missingStartTime) / 1000);
    missingTime.textContent = `${elapsedSeconds} detik`;
    detectInfo.textContent = "Tidak terlihat";

    if (elapsedSeconds < LOST_DELAY_SECONDS) {
      setStatus(
        "warning",
        "Barang Tidak Terlihat",
        `${itemLabels[targetItem]} belum terlihat selama ${elapsedSeconds} detik. Sistem sedang memastikan kondisi barang.`
      );
    } else {
      setStatus(
        "danger",
        "Barang Terdeteksi Hilang",
        `${itemLabels[targetItem]} tidak terlihat lebih dari ${LOST_DELAY_SECONDS} detik. Sistem mengirim peringatan ke pemilik barang.`
      );

      if (!alertSent) {
        alertSent = true;
        await sendLostItemNotification();
      }
    }
  }

  animationId = requestAnimationFrame(detectLoop);
}

startBtn.addEventListener("click", async () => {
  const ownerName = ownerNameInput.value.trim();
  const ownerPhone = ownerPhoneInput.value.trim();
  const location = locationInput.value.trim();
  const targetItem = targetItemInput.value;

  if (!ownerName || !ownerPhone || !location) {
    alert("Isi nama pemilik, nomor WhatsApp, dan lokasi pemantauan dulu.");
    return;
  }

  if (!model) {
    alert("Model AI belum siap. Tunggu sebentar lalu coba lagi.");
    return;
  }

  try {
    isMonitoring = true;
    missingStartTime = null;
    alertSent = false;

    itemInfo.textContent = itemLabels[targetItem];
    detectInfo.textContent = "Memulai...";
    missingTime.textContent = "0 detik";
    notifStatus.textContent = "Belum dikirim";

    setStatus(
      "warning",
      "Memulai Pemantauan",
      "Kamera sedang dinyalakan dan sistem mulai membaca objek."
    );

    await startCamera();
    addHistory(`Pemantauan dimulai untuk ${itemLabels[targetItem]} milik ${ownerName}.`);

    detectLoop();
  } catch (error) {
    console.error(error);
    isMonitoring = false;

    setStatus(
      "danger",
      "Kamera Gagal Dibuka",
      "Pastikan browser sudah mendapat izin kamera dan gunakan HTTPS atau localhost."
    );
  }
});

stopBtn.addEventListener("click", () => {
  isMonitoring = false;
  stopCamera();

  setStatus(
    "safe",
    "Pemantauan Berhenti",
    "Sistem sudah berhenti memantau barang."
  );

  detectInfo.textContent = "-";
  missingTime.textContent = "0 detik";

  addHistory("Pemantauan dihentikan.");
});

loadModel();