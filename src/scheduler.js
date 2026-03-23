import cron from "node-cron";
import { Schedules } from "./db.js";

const activeCrons = new Map(); // id → task

export function startSchedule(schedule, channel) {
  if (activeCrons.has(schedule.id)) return;

  const task = cron.schedule(
    schedule.cron,
    () => {
      channel.send(`<@${schedule.user_id}> ${schedule.message}`);

      // agendamento único: dispara uma vez e se remove
      if (!schedule.repeat) {
        task.stop();
        activeCrons.delete(schedule.id);
        Schedules.delete(schedule.id, schedule.user_id);
        console.log(`Cron #${schedule.id} removido após disparo único.`);
      }
    },
    { timezone: "America/Fortaleza" }
  );

  activeCrons.set(schedule.id, task);
  console.log(`Cron #${schedule.id} iniciado (${schedule.repeat ? "recorrente" : "único"}): ${schedule.cron} → "${schedule.message}"`);
}

export function stopSchedule(id) {
  const task = activeCrons.get(id);
  if (task) {
    task.stop();
    activeCrons.delete(id);
    console.log(`Cron #${id} removido.`);
  }
}

export function loadAllSchedules(channel) {
  const schedules = Schedules.findAll();
  for (const s of schedules) {
    startSchedule(s, channel);
  }
  console.log(`${schedules.length} agendamento(s) carregado(s) do banco.`);
}
