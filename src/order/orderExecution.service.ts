import { ExecutedOrders } from './entity/executed-orders.entity';
import { RpcException, ClientProxy } from '@nestjs/microservices';
import { OrderExecutionDTO } from './dto/orders.dto';
import { InjectRepository } from '@nestjs/typeorm';
import { Injectable, Inject, Logger } from '@nestjs/common';
import { Orders } from './entity/orders.entity';
import {
  Repository,
  MoreThan,
  MoreThanOrEqual,
  LessThanOrEqual,
  getManager,
} from 'typeorm';
import * as moment from 'moment';
import { generateHashId } from '../utils/hashId';
import * as math from 'mathjs';
import { CustomFee } from './entity/custom_fees.entity';
import { DefaultFee } from './entity/default_fees.entity';
import { Trades } from './entity/trades.entity';
import { OrderService } from './order.service';
import { User } from './entity/user.entity';
import * as currencyFormatter from 'currency-formatter';
import { Transactions } from './entity/transaction.entity';
import { TransactionRedisService } from '../transactionRedis.service';
import { ICoin } from '../interface/ICoin';

@Injectable()
export class OrderExecutionService {
  constructor(
    @InjectRepository(Orders)
    private readonly orderRepository: Repository<Orders>,
    @InjectRepository(ExecutedOrders)
    private readonly executedOrdersRepository: Repository<ExecutedOrders>,
    @InjectRepository(CustomFee)
    private readonly customFeeRepository: Repository<CustomFee>,
    @InjectRepository(DefaultFee)
    private readonly defaultFeeRepository: Repository<DefaultFee>,
    @InjectRepository(Trades)
    private readonly tradesRepository: Repository<Trades>,
    @InjectRepository(Transactions)
    private readonly transactionsRepository: Repository<Transactions>,
    @Inject('NATS_CLIENT')
    private readonly clientProxy: ClientProxy,
    private readonly orderService: OrderService,
    private readonly transactionRedisService: TransactionRedisService,
  ) {
  }

  async run(data: OrderExecutionDTO) {
    let userCompatible: User;
    let userIdentified: User;
    let ordersExecuted: Array<{
      done: number;
      orderIdentificator: string;
      amount: number;
    }> = [];

    const orders = await this.searchOrders(data.order_identificator);

    const { ordersCompatibles, orderIdentified } = orders;

    // error don`t have order compativeis.
    if (ordersCompatibles.length === 0) {
      throw new RpcException('Nenhuma ordem compativel');
    }
    Logger.log('Get orders to execute', 'orderExecution.run', true);
    userCompatible = ordersCompatibles[0].user;
    userIdentified = orderIdentified.user;
    const usersIdToBeBlockIfFail = new Set();
    usersIdToBeBlockIfFail.add(userCompatible.id);
    try {
      for await (const order of ordersCompatibles) {
        if (orderIdentified.done === 1) {
          break;
        }
        userCompatible = order.user;
        if (!usersIdToBeBlockIfFail.has(userCompatible.id))
          usersIdToBeBlockIfFail.add(userCompatible.id);

        const {
          orderCompatibleExecuted,
          orderIdentifiedExecuted,
        } = await this.executeOrder(orderIdentified, order);

        // prepara os dados que serão enviados para o front
        ordersExecuted = [
          ...ordersExecuted,
          {
            done: orderCompatibleExecuted.done,
            orderIdentificator: orderCompatibleExecuted.identificator,
            amount: orderCompatibleExecuted.amount,
          },
          {
            done: orderIdentifiedExecuted.done,
            orderIdentificator: orderIdentifiedExecuted.identificator,
            amount: orderIdentifiedExecuted.amount,
          },
        ];
      }
      Logger.log(
        `execution finished ${JSON.stringify(ordersExecuted)}`,
        'OrderExecutionService.run',
        true,
      );
      return {
        success: true,
        userIdCompatible: userCompatible.uid,
        userIdIdentified: userIdentified.uid,
        ordersExecuted,
      };
    } catch (err) {
      await this.blockUserCompatibles(usersIdToBeBlockIfFail, err);
      await this.clientProxy
        .send(
          { cmd: 'block_user_account' },
          {
            userId: userIdentified.id,
          },
        )
        .toPromise()
        .catch(async err =>
          Logger.error(
            `erro ao bloquear o usuario Identificado:${userIdentified.id}`,
            err,
            'OrderExecutionService.run',
          ),
        );

      Logger.error(
        `Erro na execucao de ordem ${err.message}`,
        err,
        'OrderExecutionService.run',
      );

      throw new RpcException(err.message);
    }
  }

  private async blockUserCompatibles(usersIdToBeBlockIfFail, error) {
    for (const userIdToBlock of usersIdToBeBlockIfFail) {
      await this.clientProxy
        .send(
          { cmd: 'block_user_account' },
          {
            userId: userIdToBlock,
          },
        )
        .toPromise()
        .catch(async err =>
          Logger.error(
            `erro ao bloquear o usuario compativel:${userIdToBlock}`,
            err,
            'OrderExecutionService.run',
          ),
        );
    }
    Logger.error(
      `bloqueado os usuarios com id: ${usersIdToBeBlockIfFail}`,
      error,
      'OrderExecutionService.run',
    );
  };

  private async getOrderByIdentificator(identificator: string) {
    return await this.orderRepository.findOne({
      where: {
        identificator,
        done: 0,
        del: 0,
        locked: 0,
        price_unity: MoreThan(0),
        amount: MoreThan(0),
      },
      relations: ['user'],
    });
  }

  private async searchOrders(orderId: string) {
    Logger.log(
      `FIND ORDER, orderId: ${orderId}`,
      'OrderExecutionService.searchOrders',
      true,
    );
    const defaultOrderResponse = {
      orderIdentified: null,
      ordersCompatibles: [],
    };
    const orderIdentified = await this.getOrderByIdentificator(orderId);

    if (!orderIdentified) {
      return defaultOrderResponse;
    }

    const pair = orderIdentified.pair.replace('/', '_').toLowerCase();

    try {
      await this.orderService.validatePairAvailable({ pair });
    } catch (err) {
      return defaultOrderResponse;
    }

    const currencies = orderIdentified.pair.split('/');

    const target_asset = currencies[0];
    const base_asset = currencies[1];

    try {
      await this.orderService.validateCoinAvailable({ coin: target_asset });
      await this.orderService.validateCoinAvailable({ coin: base_asset });
    } catch (err) {
      return defaultOrderResponse;
    }

    let price;
    let side;
    let orderBy;

    if (orderIdentified.side === 'buy') {
      side = 'sell';
      price = orderIdentified.price_unity;
      orderBy = 'ASC';
    } else if (orderIdentified.side === 'sell') {
      side = 'buy';
      price = orderIdentified.price_unity;
      orderBy = 'DESC';
    }
    // cordem compativel for mercado, priceDone
    Logger.log('FIND COMPATIBLE', 'OrderExecutionService.searchOrders', true);
    const whereSecurityParameters = {
      locked: 0,
      done: 0,
      del: 0,
      amount: MoreThan(0),
      side,
      pair: orderIdentified.pair,
    };
    let whereMatch;
    if (orderIdentified.operation_type === 'market') {
      whereMatch = {
        ...whereSecurityParameters,
      };
    } else if (orderIdentified.operation_type === 'limit') {
      whereMatch = {
        ...whereSecurityParameters,
        price_unity:
          side === 'buy' ? MoreThanOrEqual(price) : LessThanOrEqual(price),
      };
    } else {
      return defaultOrderResponse;
    }


    const ordersC = await this.orderRepository.find({
      where: whereMatch,
      order: {
        price_unity: orderBy,
        time: 'DESC',
      },
      relations: ['user'],
    });

    Logger.log(
      `Orders antes do filtro ${JSON.stringify(ordersC)}`,
      'OrderExecutionService.searchOrders',
    );

    const ordersCompatibles = ordersC.filter(
      async item =>
        await this.transactionRedisService.checkIfExists(item.user.id),
    );

    Logger.log(
      `Orders pos filtro ${JSON.stringify(ordersCompatibles)}`,
      'OrderExecutionService.searchOrders',
    );

    if (ordersCompatibles.length === 0) {
      return {
        orderIdentified,
        ordersCompatibles: [],
      };
    }
    const currenciesCompatibles = orderIdentified.pair.split('/');
    const target_assetCompatible = currenciesCompatibles[0];
    const base_assetCompatible = currenciesCompatibles[1];

    try {
      // in this case only validate the coin because that don`t need receive the type.
      await this.getICoins(target_assetCompatible, base_assetCompatible);
    } catch (err) {
      throw new RpcException('target ou base currency isn`t valid!');
    }

    return {
      orderIdentified,
      ordersCompatibles,
    };
  }

  private static async getTargetAndBaseAssetCompatible(order: Orders) {
    const currenciesCompatibles = order.pair.split('/');
    return {
      target_assetCompatible: currenciesCompatibles[0],
      base_assetCompatible: currenciesCompatibles[1],
    };
  }

  private async getICoins(target_assetCompatible, base_assetCompatible) {
    let coinTarget;
    let coinBase;
    try {
      coinTarget = await this.orderService.validateCoinAvailable({
        coin: target_assetCompatible,
      });
      coinBase = await this.orderService.validateCoinAvailable({
        coin: base_assetCompatible,
      });
      return {
        success: true,
        ICoinTarget: coinTarget.data,
        ICoinBase: coinBase.data,
      };
    } catch (err) {
      throw new RpcException('target ou base currency isn`t valid!');
    }
  }

  private static async getAmountDone(
    orderIdentifiedAmount: number,
    orderCompatibleAmount: number,
  ): Promise<number> {
    return math.number(orderIdentifiedAmount) >
    math.number(orderCompatibleAmount)
      ? orderCompatibleAmount
      : orderIdentifiedAmount;
  }

  private async getFee(order: Orders, maker: boolean) {
    const customFee = await this.customFeeRepository.findOne({
      where: {
        user_id: order.user_id,
      },
    });

    const orderPair = order.pair.replace('/', '').toLowerCase();

    if (
      !customFee ||
      customFee[`${orderPair}_${maker ? 'maker' : 'taker'}`] === null
    ) {
      const defaultFee = await this.defaultFeeRepository.findOne({
        order: {
          id: 'DESC',
        },
      });
      return defaultFee[`${orderPair}_${maker ? 'maker' : 'taker'}`];
    } else {
      return customFee[`${orderPair}_${maker ? 'maker' : 'taker'}`];
    }
  }

  private async getOrdersFee(orderIdentified: Orders, orderCompatible: Orders) {
    const firstOrderId =
      orderIdentified.id < orderCompatible.id
        ? orderIdentified.id
        : orderCompatible.id;

    let orderFee;
    let orderCompatibleFee;

    if (firstOrderId === orderIdentified.id) {
      orderFee = await this.getFee(orderIdentified, true);
      orderCompatibleFee = await this.getFee(orderCompatible, false);
    } else {
      orderFee = await this.getFee(orderIdentified, false);
      orderCompatibleFee = await this.getFee(orderCompatible, true);
    }
    return {
      orderFee,
      orderCompatibleFee,
    };
  }

  private static async getDataFee(
    ICoinBaseFiat: number,
    ICoinTargetFiat: number,
    orderIdentifiedSide: string,
    orderCompatibleSide: string,
    amountDone: number,
    totalDone: number,
    orderFee: number,
    orderCompatibleFee: number,
  ) {
    let orderDataFee;
    let orderCompatibleDataFee;
    if (ICoinBaseFiat + ICoinTargetFiat === 0) {
      orderDataFee = math.round(
        math.multiply(
          math.divide(
            orderIdentifiedSide === 'buy' ? totalDone : amountDone,
            100,
          ),
          orderFee,
        ),
        8,
      );
      orderCompatibleDataFee = math.round(
        math.multiply(
          math.divide(
            orderCompatibleSide === 'buy' ? totalDone : amountDone,
            100,
          ),
          orderCompatibleFee,
        ),
        8,
      );
    } else {
      orderDataFee =
        orderIdentifiedSide === 'buy'
          ? math.round(math.multiply(math.divide(amountDone, 100), orderFee), 8)
          : math.round(math.multiply(math.divide(totalDone, 100), orderFee), 2);
      orderCompatibleDataFee =
        orderCompatibleSide === 'buy'
          ? math.round(
          math.multiply(math.divide(amountDone, 100), orderCompatibleFee),
          8,
          )
          : math.round(
          math.multiply(math.divide(totalDone, 100), orderCompatibleFee),
          2,
          );
    }
    return {
      orderDataFee,
      orderCompatibleDataFee,
    };
  }

  private static async getPriceDone(
    orderIdentified: Orders,
    orderCompatible: Orders,
  ): Promise<number> {
    try {
      if (
        orderIdentified.operation_type === 'market' &&
        orderCompatible.operation_type === 'market'
      ) {
        if (orderCompatible.time > orderIdentified.time) {
          return orderIdentified.price_unity;
        } else {
          return orderCompatible.price_unity;
        }
      } else if (
        orderCompatible.operation_type === 'limit' &&
        orderIdentified.operation_type === 'limit'
      ) {
        // this already check but the client say to do it.
        if (
          orderIdentified.side === 'buy' &&
          orderIdentified.price_unity <= orderCompatible.price_unity
        ) {
          return orderCompatible.time > orderIdentified.time
            ? orderIdentified.price_unity
            : orderCompatible.price_unity;
        } else if (
          orderIdentified.side === 'sell' &&
          orderIdentified.price_unity >= orderCompatible.price_unity
        ) {
          return orderCompatible.time > orderIdentified.time
            ? orderIdentified.price_unity
            : orderCompatible.price_unity;
        } else {
          return null;
        }
      } else {
        if (orderCompatible.operation_type === 'limit') {
          return orderCompatible.price_unity;
        } else if (orderIdentified.operation_type === 'limit') {
          return orderIdentified.price_unity;
        } else {
          return null;
        }
      }
    } catch (err) {
      throw new RpcException('can`t get price Done');
    }
  }

  private static async getTotalDone(
    ICoinBase: ICoin,
    ICoinTarget: ICoin,
    amountDone,
    priceDone: number,
  ): Promise<number> {
    return ICoinBase.fiat + ICoinTarget.fiat >= 1
      ? math.round(math.multiply(amountDone, priceDone), 2)
      : math.round(math.multiply(amountDone, priceDone), 8);
  }

  private async executeOrder(orderIdentified: Orders, orderCompatible: Orders) {
    Logger.log('EXECUTION', 'OrderExecutionService.executeOrder', true);
    Logger.log(
      `ORDER IDENTIFIED: ${orderIdentified.identificator}`,
      'OrderExecutionService.executeOrder',
      true,
    );
    Logger.log(
      `ORDER COMPATIBLE: ${orderCompatible.identificator}`,
      'OrderExecutionService.executeOrder',
      true,
    );
    try {
      orderCompatible.locked = 1;
      orderIdentified.locked = 1;

      await orderCompatible.save();
      await orderIdentified.save();
    } catch (e) {
      throw new Error(e);
    }


    Logger.log(`locked orders: ${[orderIdentified.identificator, orderCompatible.identificator]}`, 'OrderExecution.Transaction', true);
    let amountDone: number;

    amountDone = await OrderExecutionService.getAmountDone(
      orderIdentified.amount,
      orderCompatible.amount,
    );
    Logger.log(`amountDone:${amountDone}`, 'OrderExecution.Transaction', true);
    // calculate price done
    const priceDone: number = await OrderExecutionService.getPriceDone(
      orderIdentified,
      orderCompatible,
    );
    Logger.log(`priceDone:${priceDone}`, 'OrderExecution.Transaction', true);
    Logger.log('getting assetCompatible', 'OrderExecution.Transaction', true);
    const {
      target_assetCompatible,
      base_assetCompatible,
    } = await OrderExecutionService.getTargetAndBaseAssetCompatible(orderIdentified);
    Logger.log(`target_assetCompatible:${target_assetCompatible} and base_assetCompatible:${base_assetCompatible}`, 'OrderExecution.Transaction', true);
    Logger.log('getting ICoins', 'OrderExecution.Transaction', true);
    const { ICoinTarget, ICoinBase } = await this.getICoins(
      target_assetCompatible,
      base_assetCompatible,
    );
    Logger.log(`target coin:${ICoinTarget} and Base Coin:${ICoinBase}`, 'OrderExecution.Transaction', true);
    Logger.log('getting total done', 'OrderExecution.Transaction', true);
    const totalDone = await OrderExecutionService.getTotalDone(
      ICoinBase,
      ICoinTarget,
      amountDone,
      priceDone,
    );
    Logger.log(`total done :${totalDone}`, 'OrderExecution.Transaction', true);
    Logger.log('getting order fee', 'OrderExecution.Transaction', true);
    const { orderFee, orderCompatibleFee } = await this.getOrdersFee(
      orderIdentified,
      orderCompatible,
    );
    Logger.log('porcentagem taxa 1 = ', 'OrderExecution.Transaction', true);
    Logger.log(orderFee, 'OrderExecution.Transaction', true);
    Logger.log('porcentagem taxa 2 = ', 'OrderExecution.Transaction', true);
    Logger.log(orderCompatibleFee, 'OrderExecution.Transaction', true);

    const isOrderDone = orderIdentified.amount_source === amountDone ? 1 : 0;
    const isOrderCompatibleOrder =
      orderCompatible.amount_source === amountDone ? 1 : 0;

    // get orderDataFee and compatibleData fee
    const { orderDataFee, orderCompatibleDataFee } = await OrderExecutionService.getDataFee(
      ICoinBase.fiat,
      ICoinTarget.fiat,
      orderIdentified.side,
      orderCompatible.side,
      amountDone,
      totalDone,
      orderFee,
      orderCompatibleFee,
    );

    Logger.log('Taxa efetiva 1:', 'OrderExecution.Transaction', true);
    Logger.log(orderDataFee, 'OrderExecution.Transaction', true);
    Logger.log('Taxa efetiva 2:', 'OrderExecution.Transaction', true);
    Logger.log(orderCompatibleDataFee, 'OrderExecution.Transaction', true);

    let executedOrder;
    let executedOrderCompatible;

    try {
      const executionId = generateHashId();
      const timeExecuted = moment().format();

      executedOrder = await this.executedOrdersRepository
        .create({
          execution_id: executionId,
          int_done: isOrderDone,
          order_id: orderIdentified.id,
          side: orderIdentified.side,
          pair: orderIdentified.pair,
          user_id: orderIdentified.user_id,
          price_unity: priceDone,
          order_amount: orderIdentified.amount_source,
          amount_executed: amountDone,
          fee: orderDataFee,
          amount_left: math.round(
            math.subtract(orderIdentified.amount, amountDone),
            8,
          ),
          total: totalDone,
          time_executed: timeExecuted,
        })
        .save();

      executedOrderCompatible = await this.executedOrdersRepository
        .create({
          execution_id: executionId,
          int_done: isOrderCompatibleOrder,
          order_id: orderCompatible.id,
          done_with: executedOrder.id,
          side: orderCompatible.side,
          pair: orderCompatible.pair,
          user_id: orderCompatible.user_id,
          price_unity: priceDone,
          order_amount: orderCompatible.amount_source,
          amount_executed: amountDone,
          amount_left: math.round(
            math.subtract(orderCompatible.amount, amountDone),
            8,
          ),
          fee: orderCompatibleDataFee,
          total: totalDone,
          time_executed: timeExecuted,
        })
        .save();

      executedOrder.done_with = executedOrderCompatible.id;

      await executedOrder.save();

      await this.tradesRepository
        .create({
          user_id_active: orderIdentified.user.uid,
          user_id_passive: orderCompatible.user.uid,
          order_id: orderIdentified.id,
          order_compatible_id: orderCompatible.id,
          side: orderIdentified.side,
          pair: orderIdentified.pair,
          amount_executed: amountDone,
          price_unity: priceDone,
          execution_id: executionId,
          time_executed: timeExecuted,
        })
        .save();
    } catch (error) {
      throw new Error(error.message);
    }

    try {
      const transactionIdentifiedValue = await this.transactionsRepository.create(
        {
          user_id: orderIdentified.user_id,
          coin:
            orderIdentified.side === 'buy'
              ? orderIdentified.pair.split('/')[1].toLowerCase()
              : orderIdentified.pair.split('/')[0].toLowerCase(),
          amount:
            orderIdentified.side === 'buy'
              ? totalDone * -1
              : math.round(amountDone * -1, 8),
          is_retention: 0,
          type: `order_execution_${orderIdentified.side}`,
          item_id: orderIdentified.id,
          time: moment().format(),
        },
      );

      const transactionIdentifiedAmount = await this.transactionsRepository.create(
        {
          user_id: orderIdentified.user_id,
          coin:
            orderIdentified.side === 'buy'
              ? orderIdentified.pair.split('/')[0].toLowerCase()
              : orderIdentified.pair.split('/')[1].toLowerCase(),
          amount:
            orderIdentified.side === 'buy'
              ? math.round(amountDone, 8)
              : totalDone,
          is_retention: 0,
          type: `order_execution_${orderIdentified.side}`,
          item_id: orderIdentified.id,
          time: moment().format(),
        },
      );

      const transactionIdentifiedFee = await this.transactionsRepository.create(
        {
          user_id: orderIdentified.user_id,
          coin:
            orderIdentified.side === 'buy'
              ? orderIdentified.pair.split('/')[0].toLowerCase()
              : orderIdentified.pair.split('/')[1].toLowerCase(),
          amount: orderDataFee * -1,
          is_retention: 0,
          type: `order_execution_${orderIdentified.side}_fee`,
          item_id: orderIdentified.id,
          time: moment().format(),
        },
      );

      const transactionIdentifiedRetention = await this.transactionsRepository.create(
        {
          user_id: orderIdentified.user_id,
          coin:
            orderIdentified.side === 'buy'
              ? orderIdentified.pair.split('/')[1].toLowerCase()
              : orderIdentified.pair.split('/')[0].toLowerCase(),
          amount:
            orderIdentified.side === 'buy'
              ? totalDone
              : math.round(amountDone, 8),
          is_retention: 1,
          type: `order_execution_${orderIdentified.side}`,
          item_id: orderIdentified.id,
          time: moment().format(),
        },
      );

      //////////////////////////
      /// ORDER COMPATIBLE  ///
      ////////////////////////
      const transactionCompatibleValue = await this.transactionsRepository.create(
        {
          user_id: orderCompatible.user_id,
          coin:
            orderCompatible.side === 'buy'
              ? orderCompatible.pair.split('/')[1].toLowerCase()
              : orderCompatible.pair.split('/')[0].toLowerCase(),
          amount:
            orderCompatible.side === 'buy'
              ? totalDone * -1
              : math.round(amountDone * -1, 8),
          is_retention: 0,
          type: `order_execution_${orderCompatible.side}`,
          item_id: orderCompatible.id,
          time: moment().format(),
        },
      );

      const transactionCompatibleAmount = await this.transactionsRepository.create(
        {
          user_id: orderCompatible.user_id,
          coin:
            orderCompatible.side === 'buy'
              ? orderCompatible.pair.split('/')[0].toLowerCase()
              : orderCompatible.pair.split('/')[1].toLowerCase(),
          amount:
            orderCompatible.side === 'buy'
              ? math.round(amountDone, 8)
              : totalDone,
          is_retention: 0,
          type: `order_execution_${orderCompatible.side}`,
          item_id: orderCompatible.id,
          time: moment().format(),
        },
      );

      const transactionCompatibleFee = await this.transactionsRepository.create(
        {
          user_id: orderCompatible.user_id,
          coin:
            orderCompatible.side === 'buy'
              ? orderCompatible.pair.split('/')[0].toLowerCase()
              : orderCompatible.pair.split('/')[1].toLowerCase(),
          amount: orderCompatibleDataFee * -1,
          is_retention: 0,
          type: `order_execution_${orderCompatible.side}_fee`,
          item_id: orderCompatible.id,
          time: moment().format(),
        },
      );

      const transactionCompatibleRetention = await this.transactionsRepository.create(
        {
          user_id: orderCompatible.user_id,
          coin:
            orderCompatible.side === 'buy'
              ? orderCompatible.pair.split('/')[1].toLowerCase()
              : orderCompatible.pair.split('/')[0].toLowerCase(),
          amount:
            orderCompatible.side === 'buy'
              ? totalDone
              : math.round(amountDone, 8),
          is_retention: 1,
          type: `order_execution_${orderCompatible.side}`,
          item_id: orderCompatible.id,
          time: moment().format(),
        },
      );

      await getManager().transaction(async transactionalEntityManager => {
        await transactionalEntityManager.save(transactionIdentifiedValue);
        await transactionalEntityManager.save(transactionIdentifiedAmount);
        await transactionalEntityManager.save(transactionIdentifiedFee);
        await transactionalEntityManager.save(transactionIdentifiedRetention);

        await transactionalEntityManager.save(transactionCompatibleValue);
        await transactionalEntityManager.save(transactionCompatibleAmount);
        await transactionalEntityManager.save(transactionCompatibleFee);
        await transactionalEntityManager.save(transactionCompatibleRetention);
      });
    } catch (err) {
      Logger.log(err.message, 'OrderExecution.Transaction', true);
      throw new Error(err.message);
    }

    // aqui tbm precisa checar o tipo da moeda.
    orderIdentified.amount = math.round(
      math.subtract(orderIdentified.amount, amountDone),
      8,
    );
    if (math.round(orderIdentified.amount, 8) === 0.0) {
      orderIdentified.done = 1;
      orderIdentified.price_done = priceDone;
      orderIdentified.time_done = moment().format();
      this.orderService.fixOrderTotal(orderIdentified);
    } else {
      orderIdentified.price_done = priceDone;
      orderIdentified.time_done = moment().format();
    }
    await orderIdentified.save();

    orderCompatible.amount = math.round(
      math.subtract(orderCompatible.amount, amountDone),
      8,
    );
    if (math.round(orderCompatible.amount, 8) === 0.0) {
      orderCompatible.done = 1;
      orderCompatible.price_done = priceDone;
      orderCompatible.time_done = moment().format();
      this.orderService.fixOrderTotal(orderCompatible);
    } else {
      orderCompatible.price_done = priceDone;
      orderCompatible.time_done = moment().format();
    }
    await orderCompatible.save();

    const executedCurrency = executedOrder.pair.split('/')[0];

    const coinIdentified = await this.clientProxy
      .send(
        { cmd: 'validate_coin_available' },
        {
          coin: executedCurrency,
        },
      )
      .toPromise()
      .catch(err => {
        Logger.error(err.message);
      });
    // send email here

    this.emailQueueData(executedOrder, executedOrderCompatible, coinIdentified);
    orderCompatible.locked = 0;
    await orderCompatible.save();
    orderIdentified.locked = 0;
    await orderIdentified.save();

    let internalOrder: ExecutedOrders = null;

    if (orderCompatible.user.internal_account === 1) {
      internalOrder = executedOrderCompatible;
    }

    if (orderIdentified.user.internal_account === 1) {
      internalOrder = executedOrder;
    }

    if (internalOrder) {
      this.orderService.insertBridgeOrder(internalOrder.id, internalOrder.pair);
    }

    return {
      success: true,
      orderCompatibleExecuted: orderCompatible,
      orderIdentifiedExecuted: orderIdentified,
    };
  }

  private emailQueueData(
    executedOrder: ExecutedOrders,
    executedOrderCompatible: ExecutedOrders,
    coinIdentified,
  ) {
    const emailQueueData = {
      type: 'order_executed',
      user_id: executedOrder.user_id,
      information: JSON.stringify({
        type: executedOrder.side === 'sell' ? 'venda' : 'compra',
        type_uppercase: executedOrder.side === 'sell' ? 'VENDA' : 'COMPRA',
        amount: currencyFormatter.format(executedOrder.amount_executed, {
          format: '%v',
          decimal: ',',
          thousand: '.',
          precision: 8,
        }),
        pair: executedOrder.pair.toUpperCase(),
        symbol: coinIdentified ? coinIdentified.data.currency_symbol : '',
        price: currencyFormatter.format(executedOrder.price_unity, {
          format: '%v',
          decimal: ',',
          thousand: '.',
          precision: 2,
        }),
        order_id: executedOrder.identificator,
        total: currencyFormatter.format(executedOrder.total, {
          format: '%v',
          decimal: ',',
          thousand: '.',
          precision: 2,
        }),
        date_time: moment(executedOrder.time_executed).format(
          'DD/MM/YYYY HH:mm',
        ),
      }),
    };

    this.clientProxy.send({ cmd: 'save_email_queue' }, emailQueueData);

    const emailQueueCompatibleData = {
      type: 'order_executed',
      information: JSON.stringify({
        type: executedOrderCompatible.side === 'sell' ? 'venda' : 'compra',
        type_uppercase:
          executedOrderCompatible.side === 'sell' ? 'VENDA' : 'COMPRA',
        pair: executedOrderCompatible.pair.toUpperCase(),
        amount: currencyFormatter.format(
          executedOrderCompatible.amount_executed,
          {
            format: '%v',
            decimal: ',',
            thousand: '.',
            precision: 8,
          },
        ),
        symbol: coinIdentified ? coinIdentified.data.currency_symbol : '',
        price: currencyFormatter.format(executedOrderCompatible.price_unity, {
          format: '%v',
          decimal: ',',
          thousand: '.',
          precision: 2,
        }),
        order_id: executedOrderCompatible.identificator,
        total: currencyFormatter.format(executedOrderCompatible.total, {
          format: '%v',
          decimal: ',',
          thousand: '.',
          precision: 2,
        }),
        date_time: moment(executedOrderCompatible.time_executed).format(
          'DD/MM/YYYY HH:mm',
        ),
      }),
      user_id: executedOrderCompatible.user_id,
    };

    this.clientProxy.send(
      { cmd: 'save_email_queue' },
      emailQueueCompatibleData,
    );
  }
}
