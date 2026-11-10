import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DeleteObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { randomUUID } from 'node:crypto';

export const MAX_PRODUCT_IMAGE_BYTES = 8 * 1024 * 1024;

export type UploadedImageFile = {
  buffer: Buffer;
  size: number;
  mimetype: string;
};

const IMAGE_TYPES = {
  'image/jpeg': {
    extension: 'jpg',
    matches: (buffer: Buffer) =>
      buffer.length >= 3 &&
      buffer[0] === 0xff &&
      buffer[1] === 0xd8 &&
      buffer[2] === 0xff,
  },
  'image/png': {
    extension: 'png',
    matches: (buffer: Buffer) =>
      buffer.length >= 8 &&
      buffer
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
  },
  'image/webp': {
    extension: 'webp',
    matches: (buffer: Buffer) =>
      buffer.length >= 12 &&
      buffer.toString('ascii', 0, 4) === 'RIFF' &&
      buffer.toString('ascii', 8, 12) === 'WEBP',
  },
} as const;

@Injectable()
export class ObjectStorageService {
  private readonly client: S3Client | null;
  private readonly bucket: string | null;
  private readonly publicBaseUrl: string | null;

  constructor(config: ConfigService) {
    const endpoint = config.get<string>('OBJECT_STORAGE_ENDPOINT');
    const accessKeyId = config.get<string>('OBJECT_STORAGE_ACCESS_KEY');
    const secretAccessKey = config.get<string>('OBJECT_STORAGE_SECRET_KEY');
    const region = config.get<string>('OBJECT_STORAGE_REGION') ?? 'auto';
    this.bucket = config.get<string>('OBJECT_STORAGE_BUCKET') ?? null;
    let publicBaseUrl = config.get<string>('OBJECT_STORAGE_PUBLIC_URL');
    while (publicBaseUrl?.endsWith('/'))
      publicBaseUrl = publicBaseUrl.slice(0, -1);
    this.publicBaseUrl = publicBaseUrl ?? null;
    this.client =
      endpoint && accessKeyId && secretAccessKey
        ? new S3Client({
            endpoint,
            region,
            forcePathStyle: true,
            credentials: { accessKeyId, secretAccessKey },
          })
        : null;
  }

  get configured() {
    return Boolean(this.client && this.bucket && this.publicBaseUrl);
  }

  async uploadProductImage(storeId: string, file?: UploadedImageFile) {
    if (!this.configured || !this.client || !this.bucket || !this.publicBaseUrl)
      throw new ServiceUnavailableException(
        'La carga de imágenes no está configurada. Contacta al administrador.',
      );
    if (!file || !Buffer.isBuffer(file.buffer) || file.buffer.length === 0)
      throw new BadRequestException('Selecciona una imagen para cargar.');
    if (
      file.size > MAX_PRODUCT_IMAGE_BYTES ||
      file.buffer.length > MAX_PRODUCT_IMAGE_BYTES
    )
      throw new BadRequestException('La imagen supera el límite de 8 MB.');

    const imageType = IMAGE_TYPES[file.mimetype as keyof typeof IMAGE_TYPES];
    if (!imageType?.matches(file.buffer))
      throw new BadRequestException(
        'Formato no compatible. Usa una imagen JPG, PNG o WebP.',
      );

    const key = `products/${storeId}/${randomUUID()}.${imageType.extension}`;
    const publicUrl = `${this.publicBaseUrl}/${key
      .split('/')
      .map(encodeURIComponent)
      .join('/')}`;
    if (new URL(publicUrl).protocol !== 'https:' || publicUrl.length > 180)
      throw new ServiceUnavailableException(
        'La URL pública configurada debe ser HTTPS y no superar 180 caracteres.',
      );

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: file.buffer,
        ContentLength: file.size,
        ContentType: file.mimetype,
        CacheControl: 'public, max-age=31536000, immutable',
      }),
    );
    return { key, url: publicUrl, contentType: file.mimetype, size: file.size };
  }

  async remove(key: string) {
    if (!this.configured || !this.client || !this.bucket) return;
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }
}
