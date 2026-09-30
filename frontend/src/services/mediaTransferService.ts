/**
 * Media Transfer Service
 * 
 * Handles direct Peer-to-Peer (WebRTC DataChannel) video file streaming
 * between teammates using Supabase Realtime Broadcast for lightweight signaling.
 */

import { invoke } from '@tauri-apps/api/core';
import { getSupabase } from '@/lib/supabaseClient';
import { MediaRequest, VideoFileInfo } from '@/types';

const RTC_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
  ],
};

export interface TransferProgress {
  progress: number; // 0 to 100
  bytesTransferred: number;
  totalBytes: number;
  speedMBs: number;
  currentChunk: number;
  totalChunks: number;
}

export type TransferProgressCallback = (progress: TransferProgress) => void;

interface SignalPayload {
  type: 'offer' | 'answer' | 'candidate' | 'decline' | 'complete';
  senderId: string;
  data?: any;
}

export class MediaTransferService {
  private activeConnections = new Map<string, RTCPeerConnection>();
  private activeChannels = new Map<string, RTCDataChannel>();

  /**
   * Helper: create a media request in database
   */
  async createRequest(
    meetingId: string,
    recorderId: string,
    projectId?: string
  ): Promise<MediaRequest> {
    return invoke<MediaRequest>('api_create_media_request', {
      meetingId,
      recorderId,
      projectId: projectId || null,
      mediaType: 'video',
    });
  }

  /**
   * Helper: get pending request for meeting
   */
  async getMeetingRequest(meetingId: string): Promise<MediaRequest | null> {
    return invoke<MediaRequest | null>('api_get_meeting_media_request', {
      meetingId,
    });
  }

  /**
   * Helper: get incoming requests for current user as recorder
   */
  async getIncomingRequests(): Promise<MediaRequest[]> {
    return invoke<MediaRequest[]>('api_get_incoming_media_requests');
  }

  /**
   * Helper: update request status
   */
  async updateStatus(
    requestId: string,
    status: MediaRequest['status'],
    progress?: number
  ): Promise<boolean> {
    return invoke<boolean>('api_update_media_request_status', {
      requestId,
      status,
      progress: progress ?? 0,
    });
  }

  /**
   * REQUESTER SIDE:
   * Starts listening for the recorder to accept and establish P2P streaming.
   */
  async startReceiver(
    requestId: string,
    meetingId: string,
    onProgress: TransferProgressCallback,
    onComplete: () => void,
    onError: (err: string) => void
  ): Promise<() => void> {
    const supabase = getSupabase();
    if (!supabase) {
      onError('Supabase client not available');
      return () => {};
    }

    const channelName = `media-transfer:${requestId}`;
    const channel = supabase.channel(channelName);

    const pc = new RTCPeerConnection(RTC_CONFIG);
    this.activeConnections.set(requestId, pc);

    let expectedHeader: {
      fileName: string;
      fileSize: number;
      totalChunks: number;
      chunkSize: number;
    } | null = null;

    let receivedBytes = 0;
    let startTime = Date.now();

    // Send local ICE candidates to sender
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        channel.send({
          type: 'broadcast',
          event: 'signal',
          payload: {
            type: 'candidate',
            senderId: 'receiver',
            data: event.candidate.toJSON(),
          },
        });
      }
    };

    // When sender creates DataChannel, receiver handles incoming chunks
    pc.ondatachannel = (event) => {
      const dataChannel = event.channel;
      dataChannel.binaryType = 'arraybuffer';
      this.activeChannels.set(requestId, dataChannel);

      dataChannel.onmessage = async (msgEvent) => {
        try {
          if (typeof msgEvent.data === 'string') {
            const parsed = JSON.parse(msgEvent.data);
            if (parsed.type === 'header') {
              expectedHeader = parsed;
              startTime = Date.now();
              console.log(`📡 Receiver received file header for ${meetingId}:`, parsed);
              return;
            }
          }

          if (msgEvent.data instanceof ArrayBuffer && expectedHeader) {
            const buffer = msgEvent.data;
            const dataView = new DataView(buffer);

            // 5-byte header: uint32 chunkIndex, uint8 isFinal
            const chunkIndex = dataView.getUint32(0, true);
            const isFinal = dataView.getUint8(4) === 1;
            const chunkData = Array.from(new Uint8Array(buffer, 5));

            receivedBytes += chunkData.length;
            const elapsedSec = (Date.now() - startTime) / 1000;
            const speedMBs = elapsedSec > 0 ? (receivedBytes / (1024 * 1024)) / elapsedSec : 0;
            const progress = Math.min(
              100,
              Math.round(((chunkIndex + 1) / expectedHeader.totalChunks) * 100)
            );

            onProgress({
              progress,
              bytesTransferred: receivedBytes,
              totalBytes: expectedHeader.fileSize,
              speedMBs: parseFloat(speedMBs.toFixed(2)),
              currentChunk: chunkIndex + 1,
              totalChunks: expectedHeader.totalChunks,
            });

            // Write chunk through Tauri
            await invoke('api_write_p2p_chunk', {
              meetingId,
              fileName: expectedHeader.fileName,
              chunkIndex,
              chunkSize: expectedHeader.chunkSize,
              chunkData,
              isFinal,
            });

            if (isFinal) {
              console.log(`🎉 P2P transfer finished for meeting ${meetingId}!`);
              await this.updateStatus(requestId, 'completed', 100);
              onComplete();
              cleanup();
            }
          }
        } catch (err: any) {
          console.error('Error processing received chunk:', err);
          onError(err.message || 'Error processing received chunk');
        }
      };
    };

    // Listen to signaling messages
    channel
      .on('broadcast', { event: 'signal' }, async ({ payload }: { payload: SignalPayload }) => {
        if (!payload) return;

        if (payload.type === 'offer' && payload.data) {
          try {
            console.log('📡 Receiver received SDP offer');
            await pc.setRemoteDescription(new RTCSessionDescription(payload.data));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);

            channel.send({
              type: 'broadcast',
              event: 'signal',
              payload: {
                type: 'answer',
                senderId: 'receiver',
                data: answer,
              },
            });
            console.log('📡 Receiver sent SDP answer');
          } catch (e: any) {
            console.error('Failed to handle SDP offer:', e);
            onError(e.message || 'WebRTC offer handshake failed');
          }
        } else if (payload.type === 'candidate' && payload.data) {
          try {
            await pc.addIceCandidate(new RTCIceCandidate(payload.data));
          } catch (e) {
            console.warn('Could not add ICE candidate:', e);
          }
        } else if (payload.type === 'decline') {
          onError('The meeting recorder declined the recording request.');
          cleanup();
        }
      })
      .subscribe((status) => {
        console.log(`📡 Receiver joined transfer channel ${channelName}: ${status}`);
      });

    const cleanup = () => {
      try {
        const dc = this.activeChannels.get(requestId);
        if (dc) {
          dc.close();
          this.activeChannels.delete(requestId);
        }
        pc.close();
        this.activeConnections.delete(requestId);
        supabase.removeChannel(channel);
      } catch (e) {
        console.warn('Error during receiver cleanup:', e);
      }
    };

    return cleanup;
  }

  /**
   * SENDER (RECORDER) SIDE:
   * Accepts request, connects via WebRTC DataChannel, and streams video chunks.
   */
  async startSender(
    request: MediaRequest,
    folderPath: string,
    onProgress?: TransferProgressCallback,
    onComplete?: () => void,
    onError?: (err: string) => void
  ): Promise<() => void> {
    const supabase = getSupabase();
    if (!supabase) {
      onError?.('Supabase client not available');
      return () => {};
    }

    // Inspect local video file
    const fileInfo = await invoke<VideoFileInfo | null>('api_get_meeting_video_info', {
      folderPath,
      chunkSize: 64 * 1024, // 64KB
    });

    if (!fileInfo) {
      onError?.('Recording video file not found on your machine');
      return () => {};
    }

    const channelName = `media-transfer:${request.id}`;
    const channel = supabase.channel(channelName);

    const pc = new RTCPeerConnection(RTC_CONFIG);
    this.activeConnections.set(request.id, pc);

    const dataChannel = pc.createDataChannel('fileTransfer', {
      ordered: true,
    });
    dataChannel.binaryType = 'arraybuffer';
    this.activeChannels.set(request.id, dataChannel);

    // Send local ICE candidates to receiver
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        channel.send({
          type: 'broadcast',
          event: 'signal',
          payload: {
            type: 'candidate',
            senderId: 'sender',
            data: event.candidate.toJSON(),
          },
        });
      }
    };

    // When DataChannel opens, stream file chunks
    dataChannel.onopen = async () => {
      console.log(`🚀 DataChannel opened for request ${request.id}. Starting chunk stream...`);
      await this.updateStatus(request.id, 'transferring', 0);

      // 1. Send file header metadata
      dataChannel.send(
        JSON.stringify({
          type: 'header',
          fileName: fileInfo.file_name,
          fileSize: fileInfo.file_size,
          totalChunks: fileInfo.total_chunks,
          chunkSize: fileInfo.chunk_size,
        })
      );

      let bytesSent = 0;
      const startTime = Date.now();

      // 2. Stream chunks sequentially
      for (let chunkIndex = 0; chunkIndex < fileInfo.total_chunks; chunkIndex++) {
        // Read chunk bytes from Tauri
        const chunkBytes = await invoke<number[]>('api_read_video_chunk', {
          filePath: fileInfo.file_path,
          chunkIndex,
          chunkSize: fileInfo.chunk_size,
        });

        // Pack 5-byte header: uint32 chunkIndex, uint8 isFinal
        const isFinal = chunkIndex === fileInfo.total_chunks - 1;
        const packet = new Uint8Array(5 + chunkBytes.length);
        const view = new DataView(packet.buffer);
        view.setUint32(0, chunkIndex, true);
        view.setUint8(4, isFinal ? 1 : 0);
        packet.set(chunkBytes, 5);

        // Flow control: wait if buffer exceeds 1MB to prevent backpressure drops
        if (dataChannel.bufferedAmount > 1024 * 1024) {
          await new Promise<void>((resolve) => {
            const handleLow = () => {
              dataChannel.removeEventListener('bufferedamountlow', handleLow);
              resolve();
            };
            dataChannel.addEventListener('bufferedamountlow', handleLow);
          });
        }

        dataChannel.send(packet.buffer);
        bytesSent += chunkBytes.length;

        const elapsedSec = (Date.now() - startTime) / 1000;
        const speedMBs = elapsedSec > 0 ? (bytesSent / (1024 * 1024)) / elapsedSec : 0;
        const progress = Math.min(
          100,
          Math.round(((chunkIndex + 1) / fileInfo.total_chunks) * 100)
        );

        onProgress?.({
          progress,
          bytesTransferred: bytesSent,
          totalBytes: fileInfo.file_size,
          speedMBs: parseFloat(speedMBs.toFixed(2)),
          currentChunk: chunkIndex + 1,
          totalChunks: fileInfo.total_chunks,
        });

        // Small yield every 16 chunks to keep event loop responsive
        if (chunkIndex % 16 === 0) {
          await new Promise((r) => setTimeout(r, 0));
        }
      }

      console.log(`✅ Sender finished streaming all chunks for request ${request.id}`);
      await this.updateStatus(request.id, 'completed', 100);
      onComplete?.();
    };

    // Listen to signaling messages (answer & candidate)
    channel
      .on('broadcast', { event: 'signal' }, async ({ payload }: { payload: SignalPayload }) => {
        if (!payload) return;

        if (payload.type === 'answer' && payload.data) {
          try {
            console.log('📡 Sender received SDP answer');
            await pc.setRemoteDescription(new RTCSessionDescription(payload.data));
          } catch (e: any) {
            console.error('Failed to set remote answer:', e);
            onError?.(e.message || 'WebRTC answer handshake failed');
          }
        } else if (payload.type === 'candidate' && payload.data) {
          try {
            await pc.addIceCandidate(new RTCIceCandidate(payload.data));
          } catch (e) {
            console.warn('Could not add ICE candidate on sender:', e);
          }
        }
      })
      .subscribe(async (status) => {
        console.log(`📡 Sender joined transfer channel ${channelName}: ${status}`);
        if (status === 'SUBSCRIBED') {
          // Send Offer
          try {
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            channel.send({
              type: 'broadcast',
              event: 'signal',
              payload: {
                type: 'offer',
                senderId: 'sender',
                data: offer,
              },
            });
            console.log('📡 Sender created & broadcasted SDP offer');
          } catch (err: any) {
            console.error('Failed to create SDP offer:', err);
            onError?.(err.message || 'Failed to create WebRTC offer');
          }
        }
      });

    const cleanup = () => {
      try {
        dataChannel.close();
        this.activeChannels.delete(request.id);
        pc.close();
        this.activeConnections.delete(request.id);
        supabase.removeChannel(channel);
      } catch (e) {
        console.warn('Error during sender cleanup:', e);
      }
    };

    return cleanup;
  }

  /**
   * Decline a media request
   */
  async declineRequest(request: MediaRequest): Promise<void> {
    await this.updateStatus(request.id, 'declined', 0);
    const supabase = getSupabase();
    if (supabase) {
      const channel = supabase.channel(`media-transfer:${request.id}`);
      channel.send({
        type: 'broadcast',
        event: 'signal',
        payload: {
          type: 'decline',
          senderId: 'sender',
        },
      });
    }
  }
}

export const mediaTransferService = new MediaTransferService();
