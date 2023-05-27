import { Telegraf, session } from 'telegraf';
import { message } from 'telegraf/filters';
import { code } from 'telegraf/format';
import config from 'config';
import { ogg } from './ogg.js';
import { openai } from './openai.js';
import axios from 'axios';
import { Image } from 'canvas';
import base64 from 'base64-js';
import pTimeout from 'p-timeout';
import io from 'io';

console.log(config.get('TEST_ENV'));

const A1111_API_URL = 'http://127.0.0.1:7860/sdapi/v1/txt2img';

const bot = new Telegraf(config.get('TELEGRAM_TOKEN'));

bot.use(session());

const INITIAL_SESSION = {
  messages: [],
};

bot.command('new', async (ctx) => {
  ctx.session = INITIAL_SESSION;
  await ctx.reply('Жду вашего голосового или текстового сообщения');
});

bot.command('start', async (ctx) => {
  ctx.session = INITIAL_SESSION;
  await ctx.reply('Жду вашего голосового или текстового сообщения');
});

bot.on(message('voice'), async (ctx) => {
  ctx.session ??= INITIAL_SESSION;
  try {
    await ctx.reply(
      code(
        'Сообщение принял. Жду ответа от сервера... (Если ответ не пришел в течении 30 секунд, рекомендуется изменить запрос либо перезапустить бота)'
      )
    );
    const link = await ctx.telegram.getFileLink(ctx.message.voice.file_id);
    const userId = String(ctx.message.from.id);
    const oggPath = await ogg.create(link.href, userId);
    const mp3Path = await ogg.toMp3(oggPath, userId);

    const text = await openai.transcription(mp3Path);
    await ctx.reply(code(`Ваш запрос: ${text}`));

    ctx.session.messages.push({ role: openai.roles.USER, content: text });

    const response = await openai.chat(ctx.session.messages);

    ctx.session.messages.push({
      role: openai.roles.ASSISTANT,
      content: response.message.content,
    });

    if (response && response.message && response.message.content) {
      await ctx.reply(response.message.content);
    } else {
      console.log('Invalid response received from OpenAI');
    }
  } catch (e) {
    console.log('Error while voice message', e.message);
  }
});

bot.on(message('text'), async (ctx) => {
  ctx.session ??= INITIAL_SESSION;
  try {
    if (ctx.message.text.toLowerCase() === 'testgenerating') {
      ctx.session.state = 'prompt';
      await ctx.reply(code('Please enter your prompt:'));
    } else if (ctx.session.state === 'prompt') {
      ctx.session.prompt = ctx.message.text;
      ctx.session.state = 'negative_prompt';
      await ctx.reply(code('Please enter your negative prompt:'));
    } else if (ctx.session.state === 'negative_prompt') {
      ctx.session.negativePrompt = ctx.message.text;
      ctx.session.state = 'info';
      await ctx.reply(
        code(
          'Enter steps count, cfg scale, and denoising strength in the format "X X X.XX":'
        )
      );
    } else if (ctx.session.state === 'info') {
      const info = ctx.message.text.split(' ');
      const steps = parseInt(info[0]);
      const cfgScale = parseInt(info[1]);
      const denoisingStrength = parseFloat(info[2]);

      const payload = {
        prompt: ctx.session.prompt,
        negative_prompt: ctx.session.negativePrompt,
        steps,
        cfg_scale: cfgScale,
        denoising_strength: denoisingStrength,
      };

      await ctx.reply(code('Image generation started...'));
      const response = await pTimeout(
        axios.post(A1111_API_URL, payload),
        300000, // Timeout duration in milliseconds (300 seconds)
        'Image generation timed out. Please try again.'
      );
      const r = response.data;

      for (const i of r.images) {
        const imageData = base64.toByteArray(i.split(',', 1)[0]);
        const image = new Image();
        image.src = `data:image/jpeg;base64,${base64.fromByteArray(
          imageData
        )}`;

        const axiosResponse = await axios.get(image.src, {
          responseType: 'stream',
        });

        await ctx.replyWithPhoto({ source: axiosResponse.data });
      }

      await ctx.reply(code('Image generation completed.'));

      ctx.session = INITIAL_SESSION;
    } else {
      await ctx.reply(
        code('Сообщение принял. Жду ответа от сервера...')
      );

      ctx.session.messages.push({
        role: openai.roles.USER,
        content: ctx.message.text,
      });

      const response = await openai.chat(ctx.session.messages);

      ctx.session.messages.push({
        role: openai.roles.ASSISTANT,
        content: response.message.content,
      });

      if (response && response.message && response.message.content) {
        await ctx.reply(response.message.content);
      } else {
        console.log('Invalid response received from OpenAI');
      }
    }
  } catch (e) {
    console.log('Error while processing message', e.message);
  }
});

bot.launch();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
