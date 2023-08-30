# Confirm reminder

This service is used to re-send the DOI if supporters ignore a previous one.

- It can work with any org (not bound to any CRM etc)
- It watches how Proca Server is processing actions and injects actions again if they need to send another confirm email.

## How does it work

We need to monitor two queues:

- `UNCONFIRMED_QUEUE` [1] with double opt-in demands that contains a copy of every action generating a confirmation/double opt-in email, both the initial signature AND the reminders (that are basically a copy of the initial doi)
- `CONFIRMED_QUEUE` - with all the actions confirmed (ie. where the supporter clicked on the email sent from the confirm queue)

the principle is that we requeue all the messages that we received in the UNCONFIRMED_QUEUE after x days (we send a reminder) unless we received them into the CONFIRMED_QUEUE (we don't send the reminder if the supporter confirmed, obviously)

and now more details...

### Normal Proca Server workflow:

1. a New action for DOI goes into `confirm supporter` queue.
2. the Build in email worker sends a DOI email
3. the Supporter clicks a link which results in adding the action to `delivery` queue and `email supporter`, as ACCEPTED.
4. the Delivery queue is read by CRM syncer, it synces to CRM; the `email supporter` is read by build in email worker, it sends a thank you email.

### Proca Workflow with this confirm reminder:

1. New action for DOI goes into `confirm supporter` queue.
   1a. The action _also_ goes to `cus.ORG_ID.confirm.supporter` because custom supporter confirm was enabled on org.
2. Build in email worker sends a DOI email
   2a. Confirm Reminder reads the `cus.ORG_ID.confirm.supporter`. it can either be a new supporter (it saves it in our local database (LevelDB) - to remember it's due to for confirmation OR
   2b. this action is a duplicate (send by the reminder in 5.) and we skip it
3. Supporter clicks a link which results in adding the action to `delivery` queue and `email supporter`, as ACCEPTED
   3a. A copy of action goes into `cus.ORG_ID.confirmed ` queue, which was created by hand in RabbitMQ admin and connected to `deliver` exchange for that org.
4. Delivery queue is read by CRM syncer, it synces to CRM; the `email supporter` is read by build in email worker, it sends a thank you email.
   4a. `cus.ORG_ID.confirmed` queue is read by Confirm Reminder, and the action is marked as confirmed in local DB. We are not interested about it any more, because it is confirmed.

5. Every day, we check the local DB to see which actions were unconfirmed and when. We use a `RETRY_INTERVAL=2,3` to wait first 2 days, and then for 3 days, to perform 1st and 2nd attempt to send the email.

- If the time is right to re-send the confirm email, we inject the action into supporter confirm exchange `org.ORG_ID.confirm.supporter`, so the email is send as in point 2.
- If too many attempts were done already, we mark the action as done but not confirmed.

# Confirm reminder

Action taken from the queue can have three kinds of records in the Level database.

- Action record - key: 'action + actionId', value: action;
- Retry record - key: 'retry+ actionId', value: retry date, attempts
- Done record - key: 'done + actionId', value: done , status, date [2]

If the action gets confirmed or reminders have been sent max times, retry and the action record will be deleted.

## How it works

### 1. The Cron job runs every minute and goes through "retry" records in the Level database.

#### If retry record with max retries\* is found

- adds done record: false
- deletes action record
- deletes retry record

#### If the retry date is < today and there are fewer than max retries

- gets the action record from DB
- requeues the action to UNCONFIRMED_QUEUE
- changes retry date and retries count in the retry record

### 2. syncQueue reads from UNCONFIRMED_QUEUE, when action with dupe 0 found

looks for action record in DB, if found, then nothing, if new action: - creates action record - creates retry record

### 3. syncQueue reads from CONFIRMED_QUEUE when action found

- adds done: true record
- deletes action record
- deletes retry record

## Answer to the Ultimate Question of Life, the Universe, and Everything

If we successfully restart the service reminders will be sent to all supporters from the UNCONFIRMED_QUEUE queue with actions not older than MAX_PERIOD. They will receive max 3 reminders 2 and 3 days apart (as expected). We have a safety mechanism against sending more reminders.
**Problem**: We are reading faster actions from CONFIRMED_QUEUE. To be solved with 5.0.0
\*max retries value is 3 by default, can be defined in ENV

## Do you understand RabbitMQ queue vs exchange?

In RabbitMQ, an exchange is a message routing agent that receives messages from producers and routes them to message queues. It's like a post office, where the exchange decides where to deliver messages based on the message's routing key. Exchanges come in several types, such as direct, topic, fanout, and headers, which determine how messages are routed.

When a message is sent to an exchange, the exchange will route the message to one or more queues that are bound to it. Queues are like buffers that hold messages until they can be processed. A message can be routed to multiple queues if they are bound to the same exchange. This is useful in scenarios where multiple consumers need to receive the same message for processing.

For example, let's say we have two queues, Queue A and Queue B, that are both bound to the same exchange. When a message is sent to the exchange, the exchange will route a copy of the message to both Queue A and Queue B, allowing multiple consumers to process the same message simultaneously.

In summary, when two queues are bound to the same exchange, they will both receive a copy of any message that is sent to that exchange, allowing multiple consumers to receive and process the same message.

## Configuration

- `DB_PATH` - Path to LevelDB (it's a directory) eg `/srv/confirm-reminder/lobbycontrol`
- `RABBIT_USER`, `RABBITMQ_PASSWORD` - RabbitMQ credentials
- `UNCONFIRMED_QUEUE` - custom supporter confirm queue, eg `cus.ORG_ID.confirm.supporter`
- `CONFIRMED_QUEUE` - a copy of delivery queue, eg `cus.ORG_ID.confirmed`, must be connected to `org.ORG_ID.deliver` exchange to get copies of accepted actions
- `REMIND_EXCHANGE` - confirm supporter stage exchange `org.ORG_ID.confirm.supporter`
- `RETRY_INTERVAL` - interval in days between consecutive attempts to send confirm email: `2,3` = try after 2 days and then again after 3 days.

[1] For Reminder 5.0.0 CONFIRM_QUEUE is renamed to UNCONFIRMED_QUEUE
[2] `done`: boolean, `status`: - if done: true - confirmed_after_NUMBER - if done: false - dropped or max_retries, `date`: timestamp
