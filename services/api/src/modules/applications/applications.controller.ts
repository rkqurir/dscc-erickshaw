import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Patch, Post, Req, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { MAX_UPLOAD_BYTES } from '@dscc/domain';
import type { Request, Response } from 'express';
import { Citizen, CitizenContext, CitizenGuard } from '../auth/guards';
import { ApplicationsService } from './applications.service';
import { contentDisposition } from './files.service';

const upload = FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 5 } });

@Controller('applications')
@UseGuards(CitizenGuard)
export class ApplicationsController {
  constructor(private readonly apps: ApplicationsService) {}

  @Post()
  @HttpCode(201)
  create(@Citizen() c: CitizenContext, @Req() req: Request) {
    return this.apps.createDraft({ userId: c.userId, ip: req.ip ?? null });
  }

  @Get()
  list(@Citizen() c: CitizenContext) {
    return this.apps.list(c.userId);
  }

  @Get(':id')
  get(@Citizen() c: CitizenContext, @Param('id') id: string) {
    return this.apps.get(id, c.userId);
  }

  @Patch(':id')
  save(@Citizen() c: CitizenContext, @Param('id') id: string, @Body() body: unknown) {
    return this.apps.saveDraft(id, c.userId, body);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Citizen() c: CitizenContext, @Param('id') id: string) {
    await this.apps.deleteDraft(id, c.userId);
  }

  @Post(':id/documents')
  @HttpCode(201)
  @UseInterceptors(upload)
  uploadDocument(
    @Citizen() c: CitizenContext,
    @Param('id') id: string,
    @Body('docType') docType: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Req() req: Request,
  ) {
    return this.apps.uploadDocument(id, { userId: c.userId, ip: req.ip ?? null }, docType, file);
  }

  @Get(':id/documents/:docId/file')
  async document(@Citizen() c: CitizenContext, @Param('id') id: string, @Param('docId') docId: string, @Res() res: Response) {
    const { meta, data } = await this.apps.readDocument(id, docId, c.userId);
    res.setHeader('Content-Type', meta.mimeType);
    res.setHeader('Content-Disposition', contentDisposition(meta.originalName, meta.mimeType));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(data);
  }

  @Post(':id/submit')
  @HttpCode(200)
  submit(@Citizen() c: CitizenContext, @Param('id') id: string, @Headers('idempotency-key') key: string | undefined, @Req() req: Request) {
    return this.apps.submit(id, { userId: c.userId, ip: req.ip ?? null }, key);
  }

  @Post(':id/withdraw')
  @HttpCode(200)
  withdraw(@Citizen() c: CitizenContext, @Param('id') id: string, @Req() req: Request) {
    return this.apps.withdraw(id, { userId: c.userId, ip: req.ip ?? null });
  }
}
