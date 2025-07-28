const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const mongoose = require('mongoose');
const { google } = require('googleapis');
const nodemailer = require('nodemailer');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});

// Booking Schema
const bookingSchema = new mongoose.Schema({
  id: String,
  date: Date,
  startTime: Date,
  endTime: Date,
  customerName: String,
  customerEmail: String,
  customerPhone: String,
  duration: String,
  shootingType: String,
  message: String,
  status: { type: String, default: 'confirmed' },
  googleEventId: String,
  createdAt: { type: Date, default: Date.now }
});

const Booking = mongoose.model('Booking', bookingSchema);

// Closed Days Schema
const closedDaySchema = new mongoose.Schema({
  date: Date,
  reason: String,
  type: { type: String, enum: ['holiday', 'maintenance', 'personal'], default: 'personal' }
});

const ClosedDay = mongoose.model('ClosedDay', closedDaySchema);

// Google Calendar Setup
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

// Set credentials (you'll need to handle OAuth flow)
oauth2Client.setCredentials({
  refresh_token: process.env.GOOGLE_REFRESH_TOKEN
});

const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

// Email Setup
const transporter = nodemailer.createTransporter({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

// Utility Functions
function isWeekend(date) {
  const day = date.getDay();
  return day === 0; // Only Sunday is closed, Saturday is open
}

function isHoliday(date) {
  const holidays = [
    '01-01', // Capodanno
    '01-06', // Epifania
    '04-25', // Liberazione
    '05-01', // Festa del Lavoro
    '06-02', // Festa della Repubblica
    '08-15', // Ferragosto
    '11-01', // Ognissanti
    '12-08', // Immacolata
    '12-25', // Natale
    '12-26'  // Santo Stefano
  ];
  
  const dateStr = date.toISOString().slice(5, 10);
  return holidays.includes(dateStr);
}

function getBusinessHours() {
  return {
    start: 9,  // 9:00
    end: 18,   // 18:00
    slots: ['09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00']
  };
}

// API Routes

// Get calendar availability for a month
app.get('/api/calendar/:year/:month', async (req, res) => {
  try {
    const { year, month } = req.params;
    const startDate = new Date(year, month - 1, 1);
    const endDate = new Date(year, month, 0);
    
    // Get Google Calendar events
    const googleEvents = await calendar.events.list({
      calendarId: process.env.GOOGLE_CALENDAR_ID,
      timeMin: startDate.toISOString(),
      timeMax: endDate.toISOString(),
      singleEvents: true,
      orderBy: 'startTime'
    });

    // Get closed days
    const closedDays = await ClosedDay.find({
      date: { $gte: startDate, $lte: endDate }
    });

    // Process calendar data
    const calendarData = [];
    const currentDate = new Date(startDate);
    
    while (currentDate <= endDate) {
      const dateStr = currentDate.toISOString().split('T')[0];
      let status = 'available';
      
      // Check if weekend
      if (isWeekend(currentDate)) {
        status = 'closed';
      }
      
      // Check if holiday
      if (isHoliday(currentDate)) {
        status = 'closed';
      }
      
      // Check if manually closed
      const isClosed = closedDays.some(day => 
        day.date.toISOString().split('T')[0] === dateStr
      );
      if (isClosed) {
        status = 'closed';
      }
      
      // Check if has bookings
      const hasBookings = googleEvents.data.items?.some(event => {
        if (!event.start?.dateTime) return false;
        const eventDate = new Date(event.start.dateTime).toISOString().split('T')[0];
        return eventDate === dateStr;
      });
      
      if (hasBookings && status === 'available') {
        status = 'occupied';
      }
      
      calendarData.push({
        date: dateStr,
        status: status,
        bookings: hasBookings ? googleEvents.data.items.filter(event => {
          if (!event.start?.dateTime) return false;
          const eventDate = new Date(event.start.dateTime).toISOString().split('T')[0];
          return eventDate === dateStr;
        }).length : 0
      });
      
      currentDate.setDate(currentDate.getDate() + 1);
    }
    
    res.json({
      success: true,
      data: calendarData,
      month: `${year}-${month.toString().padStart(2, '0')}`
    });
    
  } catch (error) {
    console.error('Error fetching calendar:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch calendar data'
    });
  }
});

// Get available time slots for a specific date
app.get('/api/slots/:date', async (req, res) => {
  try {
    const { date } = req.params;
    const requestDate = new Date(date);
    
    // Check if date is valid and not in the past
    if (requestDate < new Date().setHours(0, 0, 0, 0)) {
      return res.json({ success: true, slots: [] });
    }
    
    // Check if weekend or holiday
    if (isWeekend(requestDate) || isHoliday(requestDate)) {
      return res.json({ success: true, slots: [] });
    }
    
    // Get Google Calendar events for the day
    const startOfDay = new Date(requestDate);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(requestDate);
    endOfDay.setHours(23, 59, 59, 999);
    
    const googleEvents = await calendar.events.list({
      calendarId: process.env.GOOGLE_CALENDAR_ID,
      timeMin: startOfDay.toISOString(),
      timeMax: endOfDay.toISOString(),
      singleEvents: true,
      orderBy: 'startTime'
    });
    
    const businessHours = getBusinessHours();
    const availableSlots = [];
    
    businessHours.slots.forEach(timeSlot => {
      const slotTime = new Date(requestDate);
      const [hours, minutes] = timeSlot.split(':');
      slotTime.setHours(parseInt(hours), parseInt(minutes), 0, 0);
      
      // Check if slot is occupied
      const isOccupied = googleEvents.data.items?.some(event => {
        if (!event.start?.dateTime || !event.end?.dateTime) return false;
        const eventStart = new Date(event.start.dateTime);
        const eventEnd = new Date(event.end.dateTime);
        return slotTime >= eventStart && slotTime < eventEnd;
      });
      
      availableSlots.push({
        time: timeSlot,
        available: !isOccupied,
        datetime: slotTime.toISOString()
      });
    });
    
    res.json({
      success: true,
      date: date,
      slots: availableSlots
    });
    
  } catch (error) {
    console.error('Error fetching slots:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch time slots'
    });
  }
});

// Create new booking
app.post('/api/bookings', async (req, res) => {
  try {
    const {
      date,
      timeSlot,
      duration,
      customerName,
      customerEmail,
      customerPhone,
      shootingType,
      message
    } = req.body;
    
    // Validate required fields
    if (!date || !timeSlot || !duration || !customerName || !customerEmail || !customerPhone) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields'
      });
    }
    
    // Create booking dates
    const bookingDate = new Date(date);
    const [hours, minutes] = timeSlot.split(':');
    bookingDate.setHours(parseInt(hours), parseInt(minutes), 0, 0);
    
    const endDate = new Date(bookingDate);
    const durationHours = parseInt(duration.replace('h', ''));
    endDate.setHours(endDate.getHours() + durationHours);
    
    // Create Google Calendar event
    const event = {
      summary: `Shooting - ${customerName}`,
      description: `Cliente: ${customerName}\nEmail: ${customerEmail}\nTelefono: ${customerPhone}\nTipo: ${shootingType || 'Non specificato'}\nNote: ${message || 'Nessuna nota'}`,
      start: {
        dateTime: bookingDate.toISOString(),
        timeZone: 'Europe/Rome'
      },
      end: {
        dateTime: endDate.toISOString(),
        timeZone: 'Europe/Rome'
      },
      attendees: [
        { email: customerEmail }
      ]
    };
    
    const googleEvent = await calendar.events.insert({
      calendarId: process.env.GOOGLE_CALENDAR_ID,
      resource: event
    });
    
    // Save to database
    const booking = new Booking({
      id: googleEvent.data.id,
      date: bookingDate,
      startTime: bookingDate,
      endTime: endDate,
      customerName,
      customerEmail,
      customerPhone,
      duration,
      shootingType,
      message,
      googleEventId: googleEvent.data.id
    });
    
    await booking.save();
    
    // Send confirmation email
    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: customerEmail,
      cc: process.env.EMAIL_USER,
      subject: 'Conferma Prenotazione - Pixel Studio',
      html: `
        <h2>Prenotazione Confermata</h2>
        <p>Ciao ${customerName},</p>
        <p>La tua prenotazione presso Pixel Studio è stata confermata:</p>
        <ul>
          <li><strong>Data:</strong> ${bookingDate.toLocaleDateString('it-IT')}</li>
          <li><strong>Ora:</strong> ${timeSlot}</li>
          <li><strong>Durata:</strong> ${duration}</li>
          <li><strong>Tipo:</strong> ${shootingType || 'Non specificato'}</li>
        </ul>
        <p>Ti aspettiamo in studio!</p>
        <p>Pixel Studio<br>info@cophouse.com</p>
      `
    };
    
    await transporter.sendMail(mailOptions);
    
    res.json({
      success: true,
      booking: {
        id: googleEvent.data.id,
        date: bookingDate,
        timeSlot,
        duration,
        customerName
      }
    });
    
  } catch (error) {
    console.error('Error creating booking:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create booking'
    });
  }
});

// Get all bookings (admin)
app.get('/api/admin/bookings', async (req, res) => {
  try {
    const bookings = await Booking.find().sort({ startTime: 1 });
    res.json({ success: true, bookings });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Add closed day (admin)
app.post('/api/admin/closed-days', async (req, res) => {
  try {
    const { date, reason, type } = req.body;
    
    const closedDay = new ClosedDay({
      date: new Date(date),
      reason,
      type
    });
    
    await closedDay.save();
    res.json({ success: true, closedDay });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    success: true, 
    message: 'Pixel Studio Calendar API is running',
    timestamp: new Date().toISOString()
  });
});

// Serve frontend
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/index.html');
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Pixel Studio Calendar API running on port ${PORT}`);
  console.log(`📅 Calendar ID: ${process.env.GOOGLE_CALENDAR_ID}`);
  console.log(`🗄️ MongoDB connected: ${process.env.MONGODB_URI ? 'Yes' : 'No'}`);
});
