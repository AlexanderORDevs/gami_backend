import {
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ObjectStorageService } from './object-storage.service.js';

const configuration = {
  OBJECT_STORAGE_ENDPOINT: 'https://storage.example.test',
  OBJECT_STORAGE_BUCKET: 'gami-public',
  OBJECT_STORAGE_ACCESS_KEY: 'test-access-key',
  OBJECT_STORAGE_SECRET_KEY: 'test-secret-key',
  OBJECT_STORAGE_REGION: 'auto',
  OBJECT_STORAGE_PUBLIC_URL: 'https://cdn.example.test/gami',
};

it('uploads a validated image to object storage and returns only its public URL', async () => {
  const storage = new ObjectStorageService(new ConfigService(configuration));
  const send = vi.fn().mockResolvedValue({});
  (storage as unknown as { client: { send: typeof send } }).client.send = send;
  const buffer = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const result = await storage.uploadProductImage('store-id', {
    buffer,
    size: buffer.length,
    mimetype: 'image/png',
  });

  expect(result.url).toMatch(
    /^https:\/\/cdn\.example\.test\/gami\/products\/store-id\/[\da-f-]+\.png$/,
  );
  expect(result.contentType).toBe('image/png');
  expect(send.mock.calls[0][0].input).toMatchObject({
    Bucket: 'gami-public',
    ContentType: 'image/png',
    ContentLength: buffer.length,
    CacheControl: 'public, max-age=31536000, immutable',
  });
  expect(JSON.stringify(send.mock.calls[0][0].input)).not.toContain(
    'test-secret-key',
  );
});

it('rejects missing storage configuration and invalid image type or size', async () => {
  const unavailable = new ObjectStorageService(new ConfigService({}));
  await expect(
    unavailable.uploadProductImage('store-id', undefined),
  ).rejects.toBeInstanceOf(ServiceUnavailableException);

  const storage = new ObjectStorageService(new ConfigService(configuration));
  const send = vi.fn().mockResolvedValue({});
  (storage as unknown as { client: { send: typeof send } }).client.send = send;
  await expect(
    storage.uploadProductImage('store-id', {
      buffer: Buffer.from('<svg></svg>'),
      size: 11,
      mimetype: 'image/svg+xml',
    }),
  ).rejects.toBeInstanceOf(BadRequestException);
  await expect(
    storage.uploadProductImage('store-id', {
      buffer: Buffer.alloc(8),
      size: 8 * 1024 * 1024 + 1,
      mimetype: 'image/png',
    }),
  ).rejects.toBeInstanceOf(BadRequestException);
  expect(send).not.toHaveBeenCalled();
});
