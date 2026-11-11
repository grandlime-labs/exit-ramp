import { blob } from "https://esm.town/v/std/blob";

export default async function (email: Email) {
  await blob.setJSON(`inbox/${Date.now()}.json`, { from: email.from, subject: email.subject, text: email.text });
}
