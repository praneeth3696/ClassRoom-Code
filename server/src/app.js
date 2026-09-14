import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import { config, SERVER_ROOT } from './config.js';
import { describeDb, query } from './db/index.js';
import { publicLanguages } from './lib/languages.js';
import { chooseExecutor, executionQueueStats } from './services/execution.js';
import { judge0Status } from './services/judge0.js';
import { engineAvailability } from './services/dbEngines/index.js';
import { isConfigured as aiConfigured } from './services/worksheetDraft.js';
import { wrap } from './lib/http.js';
import { attachUser } from './middleware/auth.js';
import { authRouter } from './routes/auth.js';
import { academicsRouter } from './routes/academics.js';
import { coursesRouter } from './routes/courses.js';
import { questionsRouter, worksheetsRouter } from './routes/worksheets.js';
import { submissionsRouter } from './routes/submissions.js';
import { feedbackRouter, reviewRouter } from './routes/review.js';
import { courseImportsRouter, importsRouter } from './routes/imports.js';
import { errorHandler, notFoundHandler } from './middleware/errors.js';
import { securityHeaders } from './middleware/securityHeaders.js';

export function createApp() {
  const app = express();

  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(securityHeaders({ production: config.env === 'production' }));
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  app.use(
    cors({
      origin: config.webOrigin,
      credentials: true,
    }),
  );
  app.use(attachUser);

  app.get(
    '/api/health',
    wrap(async (req, res) => {
      const db = await describeDb();
      const { rows } = await query('SELECT count(*)::int AS migrations FROM schema_migrations');
      const executor = chooseExecutor();
      res.json({
        ok: true,
        env: config.env,
        db: { driver: db.driver, migrations: rows[0].migrations },
        execution: {
          executor,
          judge0: req.query.deep === 'true' ? await judge0Status() : { configured: Boolean(config.judge0.url) },
          localFallback: config.judge0.allowLocalFallback,
          databases: await engineAvailability(),
          queue: executionQueueStats(),
        },
        import: { available: aiConfigured(), model: config.ai.model },
        time: new Date().toISOString(),
      });
    }),
  );

  // Static reference data the frontend needs before a user signs in.
  app.get('/api/meta', wrap(async (req, res) => {
    res.json({
      languages: publicLanguages(),
      auth: {
        google: Boolean(config.auth.google.clientId),
        devLogin: config.auth.devLogin,
        allowedEmailDomains: config.auth.allowedEmailDomains,
      },
      execution: { executor: chooseExecutor(), databases: await engineAvailability() },
      import: { available: aiConfigured(), model: config.ai.model },
    });
  }));

  app.use('/api/auth', authRouter);
  app.use('/api', academicsRouter);
  app.use('/api/courses', coursesRouter);
  app.use('/api/courses/:courseId/imports', courseImportsRouter);
  app.use('/api/imports', importsRouter);
  app.use('/api/worksheets', worksheetsRouter);
  app.use('/api/questions', questionsRouter);
  app.use('/api/questions', submissionsRouter);
  app.use('/api', reviewRouter);
  app.use('/api/submissions', feedbackRouter);

  // In production the API also serves the built frontend, so the platform
  // deploys as a single process on the college's server (SPEC.md §11).
  const webDist = process.env.WEB_DIST || path.resolve(SERVER_ROOT, '..', 'web', 'dist');
  if (fs.existsSync(path.join(webDist, 'index.html'))) {
    app.use(express.static(webDist, { index: false, maxAge: '1h' }));
    // Anything that is not an API route is a client-side route: hand back the
    // SPA shell so deep links and refreshes work.
    app.get(/^\/(?!api\/).*/, (req, res, next) => {
      if (req.method !== 'GET') return next();
      res.sendFile(path.join(webDist, 'index.html'));
    });
    console.log(`[web] serving built frontend from ${webDist}`);
  }

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
