// Deliberate, manual smoke test. Does not create or mutate an order.
import { createEmailTransport } from "../server/email.mjs";
const id = process.argv[3];
if (process.argv[2] !== "--send-to-owner" || !/^[a-f0-9-]{36}$/i.test(id ?? "")) {
  console.error("Prueba REAL: requiere --send-to-owner seguido de un UUID nuevo. Lee OPERACION.md antes de ejecutarla.");
  process.exitCode = 1;
} else {
  const transport = createEmailTransport();
  const result = await transport.send({
    from: transport.from, to: [transport.owner], subject: "OFFCODE · Prueba controlada de correo",
    text: "Prueba controlada de la configuración de correo de OFFCODE. No corresponde a un pedido, pago ni envío.",
    html: '<html lang="es"><body style="background:#111;color:#f5f5f5;padding:32px;font-family:Arial"><h1>OFFCODE</h1><p>Prueba controlada de la configuración de correo. No corresponde a un pedido, pago ni envío.</p></body></html>',
  }, "offcode-smoke/" + id);
  console.log(JSON.stringify({ state: result.state, code: result.code }));
  if (result.state !== "accepted") process.exitCode = 1;
}
