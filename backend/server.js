const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const express = require("express");
const cors = require("cors");
const nodemailer = require("nodemailer");

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;

let reports = [];

// Cek backend aktif
app.get("/api/health", (req, res) => {
  res.json({
    message: "Backend Smart Lost Item Detection aktif"
  });
});

// Fungsi kirim email
async function sendEmailNotification(report) {
  try {
    const emailUser = process.env.EMAIL_USER?.trim();
    const emailPass = process.env.EMAIL_PASS?.replace(/\s+/g, "").trim();

    if (!emailUser || !emailPass) {
      return {
        success: false,
        status: "EMAIL_GAGAL",
        message: "EMAIL_USER atau EMAIL_PASS belum terbaca dari file .env / Railway Variables."
      };
    }

    if (!report.ownerEmail) {
      return {
        success: false,
        status: "EMAIL_GAGAL",
        message: "Email pemilik belum diisi."
      };
    }

    console.log("Cek konfigurasi email:");
    console.log("EMAIL_USER terbaca:", emailUser ? "YA" : "TIDAK");
    console.log("EMAIL_PASS terbaca:", emailPass ? "YA" : "TIDAK");

    const transporter = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      auth: {
        user: emailUser,
        pass: emailPass
      },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 10000
    });

    const mailOptions = {
      from: `"Smart Lost Item Detection" <${emailUser}>`,
      to: report.ownerEmail,
      subject: `Peringatan Barang Hilang - ${report.itemName}`,
      html: `
        <div style="font-family: Arial, sans-serif; line-height: 1.6;">
          <h2 style="color: #dc2626;">🚨 Peringatan Barang Hilang</h2>

          <p>Halo <b>${report.ownerName}</b>,</p>

          <p>
            Sistem mendeteksi bahwa barang kamu kemungkinan hilang 
            atau tidak lagi terdeteksi oleh kamera.
          </p>

          <table style="border-collapse: collapse; margin-top: 12px;">
            <tr>
              <td style="padding: 6px 12px; font-weight: bold;">Barang</td>
              <td style="padding: 6px 12px;">${report.itemName}</td>
            </tr>
            <tr>
              <td style="padding: 6px 12px; font-weight: bold;">Lokasi</td>
              <td style="padding: 6px 12px;">${report.location}</td>
            </tr>
            <tr>
              <td style="padding: 6px 12px; font-weight: bold;">Waktu</td>
              <td style="padding: 6px 12px;">${report.time}</td>
            </tr>
            <tr>
              <td style="padding: 6px 12px; font-weight: bold;">Status</td>
              <td style="padding: 6px 12px; color: #dc2626; font-weight: bold;">
                Barang tidak terdeteksi
              </td>
            </tr>
          </table>

          <p style="margin-top: 16px;">
            Segera periksa lokasi terakhir barang tersebut.
          </p>

          <p style="font-size: 12px; color: #6b7280; margin-top: 24px;">
            Email ini dikirim otomatis oleh sistem Smart Lost Item Detection.
          </p>
        </div>
      `
    };

    const info = await transporter.sendMail(mailOptions);

    return {
      success: true,
      status: "EMAIL_TERKIRIM",
      message: "Notifikasi email berhasil dikirim.",
      messageId: info.messageId
    };

  } catch (error) {
    const errorMessage = error.message || "Gagal mengirim email.";

    console.error("=================================");
    console.error("GAGAL KIRIM EMAIL");
    console.error("Pesan error:", errorMessage);
    console.error("=================================");

    return {
      success: false,
      status: "EMAIL_GAGAL",
      message: errorMessage
    };
  }
}

// Endpoint laporan barang hilang
app.post("/api/lost-item", async (req, res) => {
  try {
    const {
      ownerName,
      ownerEmail,
      itemName,
      itemClass,
      location,
      time
    } = req.body;

    if (!ownerName || !ownerEmail || !itemName || !location) {
      return res.status(400).json({
        success: false,
        message: "Data laporan belum lengkap. Nama, email, barang, dan lokasi wajib diisi."
      });
    }

    const report = {
      id: Date.now(),
      ownerName,
      ownerEmail,
      itemName,
      itemClass: itemClass || "-",
      location,
      time: time || new Date().toLocaleString("id-ID", {
        timeZone: "Asia/Jakarta"
      }),
      createdAt: new Date().toISOString(),
      notificationType: "EMAIL",
      notificationStatus: "MENUNGGU",
      notificationMessage: "Menunggu pengiriman email."
    };

    const emailResult = await sendEmailNotification(report);

    report.notificationStatus = emailResult.status;
    report.notificationMessage = emailResult.message;

    reports.push(report);

    console.log("=================================");
    console.log("LAPORAN BARANG HILANG MASUK");
    console.log("Nama Pemilik :", report.ownerName);
    console.log("Email Tujuan :", report.ownerEmail);
    console.log("Barang       :", report.itemName);
    console.log("Lokasi       :", report.location);
    console.log("Waktu        :", report.time);
    console.log("Status       :", report.notificationStatus);
    console.log("Pesan        :", report.notificationMessage);
    console.log("=================================");

    return res.status(200).json({
      success: emailResult.success,
      message: emailResult.success
        ? "Laporan diterima dan email berhasil dikirim."
        : "Laporan diterima, tetapi email gagal dikirim.",
      data: report
    });

  } catch (error) {
    console.error("Error backend:", error.message);

    return res.status(500).json({
      success: false,
      message: "Terjadi error pada backend",
      error: error.message
    });
  }
});

// Endpoint lihat semua laporan
app.get("/api/reports", (req, res) => {
  res.json({
    success: true,
    total: reports.length,
    data: reports
  });
});

app.listen(PORT, () => {
  console.log(`Backend berjalan di http://localhost:${PORT}`);
});