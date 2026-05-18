export async function sendEmail(to: string, subject: string, body: string) {
  await fetch('https://api.mail.example.com/send', {
    method: 'POST',
    body: JSON.stringify({ to, subject, body })
  });
}

export async function sendNotification(userId: string, kind: string, payload: any) {
  await sendEmail(userId, kind, JSON.stringify(payload));
}
