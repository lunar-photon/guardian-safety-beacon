package com.lunarphoton.stratus;

import android.graphics.ImageFormat;
import android.graphics.Rect;
import android.graphics.SurfaceTexture;
import android.graphics.YuvImage;
import android.hardware.Camera;
import android.os.Handler;
import android.os.Looper;

import java.io.ByteArrayOutputStream;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;

public class CameraCapture {

    public interface Callback {
        void onCaptured(byte[] jpegBytes);
    }

    public static void takePhoto(int facing, Callback callback) {
        new Thread(() -> {
            Camera camera = null;
            SurfaceTexture surfaceTexture = null;
            try {
                int cameraId = findCamera(facing);
                if (cameraId == -1) {
                    if (callback != null) callback.onCaptured(null);
                    return;
                }

                camera = Camera.open(cameraId);
                Camera.Parameters params = camera.getParameters();
                List<Camera.Size> sizes = params.getSupportedPreviewSizes();
                Camera.Size chosenSize = null;
                if (sizes != null && !sizes.isEmpty()) {
                    chosenSize = sizes.get(0);
                    for (Camera.Size s : sizes) {
                        if (s.width <= 1280 && s.width >= 640) {
                            chosenSize = s;
                            break;
                        }
                    }
                    params.setPreviewSize(chosenSize.width, chosenSize.height);
                }
                params.setPictureFormat(ImageFormat.JPEG);
                params.setJpegQuality(85);
                try { camera.setParameters(params); } catch (Exception ignored) {}

                surfaceTexture = new SurfaceTexture(42);
                camera.setPreviewTexture(surfaceTexture);
                camera.startPreview();

                final Camera finalCam = camera;
                final SurfaceTexture finalSt = surfaceTexture;
                final Camera.Size finalSize = chosenSize;
                final AtomicBoolean captured = new AtomicBoolean(false);

                // Method A: Capture directly from preview stream (silent, works with SurfaceTexture)
                finalCam.setOneShotPreviewCallback((data, cam) -> {
                    if (captured.compareAndSet(false, true)) {
                        byte[] jpeg = null;
                        if (data != null && finalSize != null) {
                            try {
                                YuvImage yuv = new YuvImage(data, ImageFormat.NV21, finalSize.width, finalSize.height, null);
                                ByteArrayOutputStream baos = new ByteArrayOutputStream();
                                yuv.compressToJpeg(new Rect(0, 0, finalSize.width, finalSize.height), 85, baos);
                                jpeg = baos.toByteArray();
                            } catch (Exception ignored) {}
                        }
                        releaseCamera(finalCam, finalSt);
                        if (callback != null) callback.onCaptured(jpeg);
                    }
                });

                // Method B fallback: If preview callback didn't fire in 500ms, try takePicture
                new Handler(Looper.getMainLooper()).postDelayed(() -> {
                    if (captured.compareAndSet(false, true)) {
                        try {
                            finalCam.takePicture(null, null, (data, cam) -> {
                                try {
                                    if (callback != null) callback.onCaptured(data);
                                } finally {
                                    releaseCamera(finalCam, finalSt);
                                }
                            });
                        } catch (Exception e) {
                            releaseCamera(finalCam, finalSt);
                            if (callback != null) callback.onCaptured(null);
                        }
                    }
                }, 500);

            } catch (Exception e) {
                releaseCamera(camera, surfaceTexture);
                if (callback != null) callback.onCaptured(null);
            }
        }).start();
    }

    private static int findCamera(int desiredFacing) {
        int numCameras = Camera.getNumberOfCameras();
        Camera.CameraInfo info = new Camera.CameraInfo();
        for (int i = 0; i < numCameras; i++) {
            Camera.getCameraInfo(i, info);
            if (info.facing == desiredFacing) {
                return i;
            }
        }
        return numCameras > 0 ? 0 : -1;
    }

    private static void releaseCamera(Camera camera, SurfaceTexture surfaceTexture) {
        if (camera != null) {
            try {
                camera.setPreviewCallback(null);
                camera.stopPreview();
            } catch (Exception ignored) {}
            try {
                camera.release();
            } catch (Exception ignored) {}
        }
        if (surfaceTexture != null) {
            try {
                surfaceTexture.release();
            } catch (Exception ignored) {}
        }
    }
}
