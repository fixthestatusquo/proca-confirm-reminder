import { syncQueue, ActionMessageV2, EventMessageV2 } from '@proca/queue';
import { changeDate, retryValid } from "./helpers"
import amqplib from 'amqplib';
import { Level } from "level";
import schedule from "node-schedule";
import parseArg from "minimist";
import dotenv from 'dotenv';
import { LevelError, RetryRecord, DoneRecord } from './types';

dotenv.config();

// READ PARAMS
const args = parseArg(process.argv.slice(2));
const db = new Level(process.env.DB_PATH || args.db || "./reminder.db", { valueEncoding: 'json' })
const user = process.env.RABBIT_USER || args.user;
const pass = process.env.RABBIT_PASSWORD || args.password;
const queueUnconfirmed = process.env.UNCONFIRMED_QUEUE || args.qc || "";
const queueConfirmed = process.env.CONFIRMED_QUEUE || args.qd || "";
const remindExchange = process.env.REMIND_EXCHANGE || args.qe || "";
const retryArray = (process.env.RETRY_INTERVAL || "2,3").split(",").map(x => parseInt(x)).filter(x => x > 0);
const maxPeriod = retryArray.reduce((max, d) => (max + d), 0) + 2;
const maxRetries = retryArray.length + 1;
const jobInterval = process.env.JOB_INTERVAL || '0 10 * * *'

// debug
const debugDayOffset = parseInt(process.env.ADD_DAYS || args.A || "0");

const amqp_url = `amqps://${user}:${pass}@api.proca.app/proca_live`;

const job = schedule.scheduleJob(jobInterval, async () => {
  console.log(`Running at ${jobInterval}, max retries: ${maxRetries}`);

  const conn = await amqplib.connect(amqp_url);
  const chan = await conn.createChannel();

  try {
    for await (const [key, value] of db.iterator<string, RetryRecord>({ gt: 'retry-' })) {
      // console.log("Confirm:", key, value);
      const actionId = key.split("-")[1];

      // we already had max retries, or retry record is too old
      if (value.attempts >= maxRetries || !retryValid(value.retry, maxPeriod) ) { // attempts counts also 1st normal confirm
        const msg = value.attempts >= maxRetries
          ? `Confirm ${actionId} had already ${value.attempts}, deleting`
          : `Confirm ${actionId} expired. ${value.retry}, deleting`;

        const status = value.attempts >= maxRetries ? "max_retries" : "dropped";

        //logging what is happened
        console.log(msg);
        await db.put<string, DoneRecord>('done-' + actionId, { done: false, status: status, date: Date.now() }, {});//date created
        await db.del('action-' + actionId);
        await db.del('retry-' + actionId);
      } else {

        const today = new Date()
        today.setDate(today.getDate() + debugDayOffset);

        // check if it is time for reminder
        if ((new Date(value.retry)) < today && value.attempts < maxRetries) {

          console.log(`Reminding action ${actionId} (due ${value.retry})`);

          // publish
          const action = await db.get<string, ActionMessageV2>("action-" + actionId, {});
          action.action.customFields.reminder = true;

          const r = await chan.publish(remindExchange,
                                       action.action.actionType + '.' + action.campaign.name,
                                       Buffer.from(JSON.stringify(action)));
          console.log('publish', r);//Retried number
            // change retry record
          let retry = await db.get<string, RetryRecord>("retry-" + actionId, {});
          retry = { retry: changeDate(value.retry, value.attempts+1, retryArray), attempts: value.attempts + 1};
          await db.put<string, RetryRecord>('retry-' + actionId, retry, {});
        }
      }
    }
  } finally {
    await chan.close();
    await conn.close()
  }
});

syncQueue(amqp_url, queueUnconfirmed, async (action: ActionMessageV2 | EventMessageV2) => {
  if (action.schema === 'proca:action:2' && action.contact.dupeRank === 0) { //else process.exit for just in case
    console.log(`Unconfirmed action `, action.actionId);



   // await db.put<string, ActionMessageV2>('action-' + action.actionId, action, {});

// catch { rearrange theorged


    // Don't remind if action from the queue is too old
    if (retryValid(action.action.createdAt, maxPeriod)) { //esle here
      try {
        // ignore if we have it
        const _payload = await db.get('action-' + action.actionId);
        //log sometng
      } catch (_error) {
        const error = _error as LevelError;

        if (error.notFound) {
          await db.put<string, ActionMessageV2>('action-' + action.actionId, action, {});
          const retry = { retry: changeDate(action.action.createdAt, 1, retryArray), attempts: 1 };
          await db.put<string, RetryRecord>('retry-' + action.actionId, retry, {});

          console.log(`Scheduled confirm reminder: ${action.actionId}`);
        } else {
          console.error(`Error checking if confirm scheduled in DB`, error);
          throw error;
        }
      }
      return true;
    }
    console.log(`${action.actionId} created at ${action.action.createdAt} from the confirm queue expired, deleting`);
      await db.put<string, DoneRecord>('done-' + action.actionId, { done: false, status: "dropped", date: Date.now()}, {});
      await db.del('action-' + action.actionId);
      await db.del('retry-' + action.actionId);
  }
  return true;
})

syncQueue(amqp_url, queueConfirmed, async (action: ActionMessageV2 | EventMessageV2) => {
  if (action.schema === 'proca:action:2') {
    console.log("Confirmed:", action.actionId);
    try {
      const retryRecord = await db.get<string, RetryRecord>("retry-" + action.actionId, {});
      await db.put<string, DoneRecord>('done-' + action.actionId, { done: true, status: `confirmed_after_${retryRecord.attempts}`, date: Date.now() }, {});
      await db.del('action-' + action.actionId);
      await db.del('retry-' + action.actionId);
    } catch (e) {
      console.error(`Error removing confirmed action ${action.actionId} record from DB`, e);
      throw e;
    }
  }
  return true;
})
