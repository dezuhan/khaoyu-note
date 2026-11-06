export async function sendAlert(config, logger, payload) {
  if (!config.alertWebhook) return false;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    const response = await fetch(config.alertWebhook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ service: "khaoyu-note", at: new Date().toISOString(), ...payload }),
      signal: controller.signal,
    });
    if (!response.ok) {
      logger?.warn("alert.webhook_failed", { status: response.status });
      return false;
    }
    return true;
  } catch (error) {
    logger?.warn("alert.webhook_failed", { message: error.message });
    return false;
  } finally {
    clearTimeout(timeout);
  }
}
