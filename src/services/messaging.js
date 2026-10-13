// Plug-in points for SMS and WhatsApp.
// Nothing is sent until you connect a provider here (Termii, Twilio, Africa's Talking, WhatsApp Cloud API...).
// Every notification in the app already calls these, so you only have to fill in the two functions below.

export async function sendSms(/* { to, text } */) {
  return false;
}

export async function sendWhatsapp(/* { to, text } */) {
  return false;
}
