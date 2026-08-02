import {
  probeWindowsNativeImageRecognition,
  describeImageWithWindowsNativeApi,
} from './windows-native-image-recognition-bridge.js';
import {
  ImageDescriptionProvider,
  ImageDescriptionRequest,
  ImageDescriptionResult,
} from './image-description-types.js';

export class WindowsNativeImageDescriptionProvider implements ImageDescriptionProvider {
  readonly id = 'windows_native';

  async isAvailable(): Promise<boolean> {
    return probeWindowsNativeImageRecognition().description;
  }

  async describe(request: ImageDescriptionRequest): Promise<ImageDescriptionResult> {
    const startedAt = Date.now();
    const description = describeImageWithWindowsNativeApi(request.path);
    return description
      ? { status: 'succeeded', provider: this.id, description, elapsedMs: Date.now() - startedAt }
      : {
          status: 'failed',
          provider: this.id,
          description: '',
          error: 'windows_native_image_description_failed',
          elapsedMs: Date.now() - startedAt,
        };
  }
}

export async function describeImage(
  request: ImageDescriptionRequest
): Promise<ImageDescriptionResult> {
  const provider = new WindowsNativeImageDescriptionProvider();
  if (!(await provider.isAvailable()))
    throw new Error('No available image description provider could be resolved.');
  return provider.describe(request);
}
